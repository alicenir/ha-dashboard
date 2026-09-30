// ha-dashboard: serves a panel dashboard and bridges it to Home Assistant.
// The HA token lives only here (server side) and is never sent to browsers.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- configuration ----------
const HA_URL = (process.env.HA_URL || '').replace(/\/+$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
const PORT = Number(process.env.PORT) || 8090;
const CONFIG_PATH = process.env.CONFIG_PATH || '/config/dashboard.json';
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.READ_ONLY || '');
// Locks and alarms are deliberately NOT controllable by default.
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS ||
  'light,switch,fan,input_boolean,cover,climate,media_player,scene,script,button,vacuum,number,input_number,todo')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!/^https?:\/\/.+/.test(HA_URL)) {
  console.error('HA_URL is not set. Set it to your Home Assistant address, e.g. http://<home-assistant-ip>:8123');
  process.exit(1);
}
if (!HA_TOKEN) {
  console.error('HA_TOKEN is not set. Create a long-lived token in HA (Profile > Security) and set it in the stack.');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// What each domain may do, and which data keys a browser may send.
const SERVICES = {
  light: ['toggle', 'turn_on', 'turn_off'],
  switch: ['toggle', 'turn_on', 'turn_off'],
  fan: ['toggle', 'turn_on', 'turn_off'],
  input_boolean: ['toggle', 'turn_on', 'turn_off'],
  cover: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'],
  climate: ['set_temperature', 'set_hvac_mode', 'turn_on', 'turn_off'],
  media_player: ['toggle', 'turn_on', 'turn_off', 'media_play_pause', 'media_next_track', 'media_previous_track', 'volume_set'],
  scene: ['turn_on'],
  script: ['turn_on'],
  button: ['press'],
  vacuum: ['start', 'pause', 'return_to_base'],
  number: ['set_value'],
  input_number: ['set_value'],
  todo: ['add_item', 'remove_item', 'update_item'],
  lock: ['lock', 'unlock'],
};

// ---------- state ----------
const store = {
  ready: false,
  config: {},
  entityReg: new Map(),    // entity_id -> registry entry
  states: new Map(),       // entity_id -> HA state object
};
let userConfig = {};
let layout = {};
let refs = new Set();      // entity ids the dashboard is allowed to see and control
const extras = { forecast: { hourly: [], daily: [] }, history: null, todo: [] };

// ---------- user config ----------
let configMtime = 0;
function loadConfig() {
  try {
    const st = statSync(CONFIG_PATH);
    if (st.mtimeMs === configMtime) return false;
    configMtime = st.mtimeMs;
    userConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    log('Loaded config from', CONFIG_PATH);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (configMtime === -1) return false;
      const changed = configMtime !== 0;
      configMtime = -1;
      userConfig = {};
      log(`No config at ${CONFIG_PATH}, using auto-detection`);
      return changed;
    }
    log('Config error (keeping previous config):', err.message);
    return false;
  }
}

// ---------- layout resolution (config + auto-detection) ----------
const has = id => typeof id === 'string' && store.states.has(id);
const attr = id => store.states.get(id)?.attributes || {};

// "key" in config wins, even when set to null (null disables the item).
const opt = (obj, key, auto) => (obj && key in obj ? obj[key] : auto());

function resolveLayout() {
  const c = userConfig;
  const ids = [...store.states.keys()].sort();
  const find = (re, pred = () => true) => ids.find(i => re.test(i) && pred(i)) || null;
  const byClass = (dc, re) => find(re, i => i.startsWith('sensor.') && attr(i).device_class === dc);

  // header status pills
  const status = opt(c, 'status', () => {
    const list = [];
    const net = find(/^binary_sensor\..*(internet|wan)/);
    if (net) list.push({ entity: net, label: 'אינטרנט', icon: 'wifi' });
    for (const p of ids.filter(i => i.startsWith('person.'))) list.push({ entity: p, icon: 'home' });
    return list;
  }) || [];

  // electricity
  const pc = c.power || {};
  const power = {
    current: opt(pc, 'current', () => byClass('current', /(main|total|home|house|grid|mains)/)),
    power: opt(pc, 'power', () => byClass('power', /(main|total|home|house|grid|mains|consumption)/)),
    breaker: Number(pc.breaker) || 25,
    today: opt(pc, 'today', () => byClass('energy', /(today|daily)/)),
    month: opt(pc, 'month', () => byClass('energy', /month/)),
    car_socket: opt(pc, 'car_socket', () => null),
    history_hours: Number(pc.history_hours) || 6,
  };

  // weather
  const wc = c.weather || {};
  const weather = {
    entity: opt(wc, 'entity', () => find(/^weather\./, i => store.states.get(i).state !== 'unavailable')),
    source: wc.source || null,
  };

  // car (auto-detects TeslaMate MQTT sensors such as sensor.tesla_battery_level)
  const cc = c.car || {};
  const battery = opt(cc, 'battery', () =>
    find(/^sensor\..*(tesla|model_?[3ysx]).*_battery_level$/) ||
    find(/^sensor\..*_battery_level$/, i => /tesla/i.test(attr(i).friendly_name || '')));
  const prefix = battery ? battery.replace(/^sensor\./, '').replace(/(usable_)?battery_level$/, '') : '';
  const sib = (...cands) => () => (prefix ? cands.map(x => x.replace('{p}', prefix)).find(has) || null : null);
  const car = battery ? {
    name: cc.name || 'טסלה',
    battery,
    range: opt(cc, 'range', sib('sensor.{p}est_battery_range_km', 'sensor.{p}rated_battery_range_km', 'sensor.{p}ideal_battery_range_km', 'sensor.{p}range')),
    plugged: opt(cc, 'plugged', sib('binary_sensor.{p}plugged_in', 'binary_sensor.{p}charge_cable')),
    state: opt(cc, 'state', sib('sensor.{p}state', 'sensor.{p}charging_state')),
    charger_power: opt(cc, 'charger_power', sib('sensor.{p}charger_power')),
    charge_limit: opt(cc, 'charge_limit', sib('number.{p}charge_limit', 'sensor.{p}charge_limit_soc')),
    charge_switch: opt(cc, 'charge_switch', sib('switch.{p}charger', 'switch.{p}charge')),
    charge_button: opt(cc, 'charge_button', () => null),
    load_balancing: opt(cc, 'load_balancing', () => null),
    commands_today: opt(cc, 'commands_today', () => null),
    commands_limit: Number(cc.commands_limit) || null,
    updated: opt(cc, 'updated', sib('sensor.{p}since', 'sensor.{p}last_update')),
  } : null;

  // home control
  const hc = c.controls || {};
  const devices = opt(hc, 'devices', () => [
    ...ids.filter(i => i.startsWith('light.')).slice(0, 8),
    ...ids.filter(i => i.startsWith('media_player.') && attr(i).device_class === 'tv').slice(0, 2),
  ].slice(0, 9)) || [];
  const actions = opt(hc, 'actions', () => {
    const list = [];
    if (devices.some(d => d.startsWith('light.'))) list.push({ type: 'all_lights_off', label: 'כיבוי כל האורות', icon: 'lightbulb-off-outline' });
    const night = find(/^(script|scene)\..*(good_?night|night|sleep)/);
    if (night) list.push({ entity: night, label: 'לילה טוב', icon: 'weather-night' });
    return list;
  }) || [];

  // tasks
  const todo = { entity: opt(c.todo || {}, 'entity', () => find(/^todo\./)) };

  // info rows
  const info = opt(c, 'info', () => {
    const list = [];
    const dryer = find(/^sensor\..*(dryer|washer|washing)/);
    if (dryer) list.push({ entity: dryer, icon: 'tumble-dryer' });
    if (has('sun.sun')) list.push({ type: 'sun' });
    const clients = find(/^sensor\..*(connected_devices|connected_clients|wifi_clients|devices_online)/);
    if (clients) list.push({ entity: clients, label: 'מכשירים ברשת', icon: 'wifi' });
    return list;
  }) || [];
  const infoResolved = info.map(r => (r.type === 'sun' ? { ...r, entity: 'sun.sun' } : r));

  layout = { status, power, weather, car, controls: { devices, actions }, todo, info: infoResolved };

  // Collect every referenced entity id: this is the browser's whole world.
  const next = new Set();
  const walk = v => {
    if (typeof v === 'string') { if (has(v)) next.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(layout);
  refs = next;
}

// ---------- serialization ----------
// Strip anything a browser shouldn't see (entity_picture carries HA access tokens).
function publicEntity(s) {
  const { entity_picture, access_token, ...attributes } = s.attributes || {};
  return {
    entity_id: s.entity_id,
    state: s.state,
    attributes,
    picture: entity_picture ? createHash('sha1').update(entity_picture).digest('hex').slice(0, 10) : null,
    last_changed: s.last_changed,
    last_updated: s.last_updated,
  };
}

function snapshot() {
  return {
    type: 'snapshot',
    config: {
      location_name: store.config.location_name || 'Home',
      read_only: READ_ONLY,
      allowed_domains: READ_ONLY ? [] : ALLOWED_DOMAINS,
      time_zone: store.config.time_zone || null,
    },
    layout,
    entities: [...refs].map(id => publicEntity(store.states.get(id))),
    forecast: extras.forecast,
    history: extras.history,
    todo: extras.todo,
  };
}

// ---------- extra data: forecasts, history, todo items ----------
async function fetchForecast() {
  const id = layout.weather?.entity;
  if (!id) return;
  for (const type of ['hourly', 'daily']) {
    try {
      const r = await ha.send({
        type: 'call_service', domain: 'weather', service: 'get_forecasts',
        service_data: { type }, target: { entity_id: id }, return_response: true,
      });
      extras.forecast[type] = (r?.response?.[id]?.forecast || []).slice(0, 24);
    } catch (err) {
      log(`Forecast (${type}) failed:`, err.message);
      extras.forecast[type] = [];
    }
  }
  broadcast({ type: 'forecast', ...extras.forecast });
}

async function fetchHistory() {
  const id = layout.power?.current;
  if (!id) { extras.history = null; return; }
  const hours = layout.power.history_hours;
  const end = Date.now();
  const start = end - hours * 3600e3;
  try {
    const r = await ha.send({
      type: 'history/history_during_period', start_time: new Date(start).toISOString(),
      entity_ids: [id], minimal_response: true, no_attributes: true, significant_changes_only: false,
    });
    const pts = (r?.[id] || []).map(x => [
      x.lu ? x.lu * 1000 : Date.parse(x.last_updated || x.last_changed),
      parseFloat(x.s ?? x.state),
    ]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
    // Bucket into 90 slots, keeping the max of each slot so peaks survive.
    const N = 90, size = (end - start) / N;
    const values = new Array(N).fill(null);
    let last = pts.length && pts[0][0] <= start ? pts[0][1] : null;
    let j = 0;
    for (let b = 0; b < N; b++) {
      const bEnd = start + (b + 1) * size;
      let max = last;
      while (j < pts.length && pts[j][0] < bEnd) {
        last = pts[j][1];
        max = max == null ? last : Math.max(max, last);
        j++;
      }
      values[b] = max;
    }
    const peak = pts.reduce((m, [, v]) => Math.max(m, v), 0);
    extras.history = { entity: id, hours, values, peak };
    broadcast({ type: 'history', ...extras.history });
  } catch (err) {
    log('History failed:', err.message);
  }
}

async function fetchTodo() {
  const id = layout.todo?.entity;
  if (!id) { extras.todo = []; return; }
  try {
    const r = await ha.send({ type: 'todo/item/list', entity_id: id });
    extras.todo = (r?.items || []).map(i => ({ uid: i.uid, summary: i.summary, status: i.status }));
    broadcast({ type: 'todo', items: extras.todo });
  } catch (err) {
    log('Todo list failed:', err.message);
  }
}

async function refreshExtras() {
  await Promise.allSettled([fetchForecast(), fetchHistory(), fetchTodo()]);
}

// ---------- Home Assistant client ----------
class HAClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.backoff = 1000;
    this.registryTimer = null;
    this.todoTimer = null;
  }

  connect() {
    const url = HA_URL.replace(/^http/, 'ws') + '/api/websocket';
    log('Connecting to', url);
    const sock = this.sock = new WebSocket(url);
    sock.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.onMessage(msg).catch(err => log('HA message error:', err.message));
    });
    sock.on('error', err => log('HA socket error:', err.message));
    sock.on('close', () => {
      this.setConnected(false);
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 60000);
      log(`HA connection closed, retrying in ${delay / 1000}s`);
      setTimeout(() => this.connect(), delay);
    });
  }

  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.readyState !== WebSocket.OPEN) return reject(new Error('not connected to HA'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.sock.send(JSON.stringify({ id, ...msg }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('HA request timed out'));
      }, 20000);
    });
  }

  async onMessage(m) {
    switch (m.type) {
      case 'auth_required':
        this.sock.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
        break;
      case 'auth_invalid':
        log('HA rejected the token (auth_invalid). Check HA_TOKEN.');
        this.backoff = 60000; // don't hammer HA with a bad token
        this.sock.close();
        break;
      case 'auth_ok':
        log('Authenticated to HA', m.ha_version || '');
        this.backoff = 1000;
        await this.init();
        break;
      case 'result': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.success ? p.resolve(m.result) : p.reject(new Error(m.error?.message || 'HA request failed'));
        break;
      }
      case 'event':
        this.onEvent(m.event);
        break;
    }
  }

  async loadRegistry() {
    const entities = await this.send({ type: 'config/entity_registry/list' });
    store.entityReg = new Map(entities.map(e => [e.entity_id, e]));
  }

  async init() {
    const [config, states] = await Promise.all([
      this.send({ type: 'get_config' }),
      this.send({ type: 'get_states' }),
      this.loadRegistry(),
    ]);
    store.config = config;
    store.states = new Map(states.map(s => [s.entity_id, s]));
    for (const event_type of ['state_changed', 'entity_registry_updated']) {
      await this.send({ type: 'subscribe_events', event_type });
    }
    resolveLayout();
    store.ready = true;
    this.setConnected(true);
    log(`Loaded ${store.states.size} entities; dashboard uses ${refs.size}`);
    broadcast(snapshot());
    refreshExtras();
  }

  onEvent(ev) {
    if (ev.event_type === 'state_changed') {
      const { entity_id, new_state } = ev.data;
      const isNew = !store.states.has(entity_id);
      if (!new_state) store.states.delete(entity_id);
      else store.states.set(entity_id, new_state);
      if (isNew || !new_state) return this.relayout();
      if (!refs.has(entity_id)) return;
      broadcast({ type: 'state', entity: publicEntity(new_state) });
      if (entity_id === layout.todo?.entity) {
        clearTimeout(this.todoTimer);
        this.todoTimer = setTimeout(fetchTodo, 400);
      }
    } else {
      this.relayout();
    }
  }

  // Entities appeared/disappeared or registry changed: re-resolve, debounced.
  relayout() {
    clearTimeout(this.registryTimer);
    this.registryTimer = setTimeout(async () => {
      try {
        await this.loadRegistry();
        resolveLayout();
        broadcast(snapshot());
      } catch (err) { log('Relayout failed:', err.message); }
    }, 2000);
  }

  setConnected(v) {
    if (this.connected === v) return;
    this.connected = v;
    if (!v) store.ready = false;
    broadcast({ type: 'ha_status', connected: v });
  }
}

const ha = new HAClient();

// ---------- browser connections ----------
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}

async function handleCall(msg) {
  if (READ_ONLY) throw new Error('dashboard is read-only');
  const { domain, service, entity_id } = msg;
  if (!ALLOWED_DOMAINS.includes(domain)) throw new Error(`control of ${domain} is not allowed`);
  if (!SERVICES[domain]?.includes(service)) throw new Error(`${domain}.${service} is not allowed`);
  if (typeof entity_id !== 'string' || entity_id.split('.')[0] !== domain || !refs.has(entity_id)) {
    throw new Error('entity is not on the dashboard');
  }
  const service_data = {};
  for (const [k, v] of Object.entries(msg.data || {})) {
    switch (k) {
      case 'brightness_pct': case 'temperature': case 'position': case 'volume_level': case 'value':
        if (Number.isFinite(v)) service_data[k] = v;
        break;
      case 'hvac_mode':
        if (typeof v === 'string' && /^[a-z_]+$/.test(v)) service_data[k] = v;
        break;
      case 'item':
        if (typeof v === 'string' && v.trim() && v.length <= 200) service_data[k] = v.trim();
        break;
      case 'status':
        if (v === 'needs_action' || v === 'completed') service_data[k] = v;
        break;
    }
  }
  await ha.send({ type: 'call_service', domain, service, service_data, target: { entity_id } });
}

// ---------- HTTP ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MDI_DIR = path.join(__dirname, 'node_modules', '@mdi', 'font');
const FONT_DIR = path.join(__dirname, 'node_modules', '@fontsource', 'rubik');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; " +
    "style-src 'self'; font-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

async function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return notFound(res);
  try {
    const st = await stat(file);
    if (!st.isFile()) return notFound(res);
    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': root === PUBLIC_DIR ? 'no-cache' : 'public, max-age=604800',
    });
    res.end(body);
  } catch {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// Proxies an entity's picture (person photo, camera, album art) using the server-side token.
async function servePicture(res, entityId) {
  const s = store.states.get(entityId);
  const pic = s?.attributes?.entity_picture;
  if (!s || !refs.has(entityId) || typeof pic !== 'string' || !pic.startsWith('/')) return notFound(res);
  try {
    const r = await fetch(HA_URL + pic, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok || !r.body) return notFound(res);
    res.writeHead(200, {
      'Content-Type': r.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': entityId.startsWith('camera.') ? 'no-store' : 'private, max-age=3600',
    });
    Readable.fromWeb(r.body).pipe(res);
  } catch (err) {
    log('Picture proxy failed for', entityId, err.message);
    if (!res.headersSent) notFound(res);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return notFound(res); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  if (p === '/healthz') {
    res.writeHead(ha.connected ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: ha.connected, entities: refs.size }));
  }
  if (p.startsWith('/api/picture/')) return servePicture(res, p.slice('/api/picture/'.length));
  if (p.startsWith('/mdi/')) return serveFile(res, MDI_DIR, p.slice('/mdi/'.length));
  if (p.startsWith('/fonts/')) return serveFile(res, FONT_DIR, p.slice('/fonts/'.length));
  return serveFile(res, PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', sock => {
  clients.add(sock);
  sock.send(JSON.stringify(store.ready ? snapshot() : { type: 'ha_status', connected: false }));
  sock.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'call') return;
    try {
      await handleCall(msg);
      sock.send(JSON.stringify({ type: 'call_result', ref: msg.ref, ok: true }));
    } catch (err) {
      sock.send(JSON.stringify({ type: 'call_result', ref: msg.ref, ok: false, error: err.message }));
    }
  });
  sock.on('close', () => clients.delete(sock));
});

loadConfig();
setInterval(() => {
  if (loadConfig() && store.ready) { resolveLayout(); broadcast(snapshot()); refreshExtras(); }
}, 10000);
setInterval(() => { if (store.ready) fetchForecast(); }, 30 * 60e3);
setInterval(() => { if (store.ready) fetchHistory(); }, 5 * 60e3);

server.listen(PORT, () => {
  log(`ha-dashboard listening on :${PORT} (HA: ${HA_URL}, read-only: ${READ_ONLY})`);
  ha.connect();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log('Shutting down'); server.close(); process.exit(0); });
}
