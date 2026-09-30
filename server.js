// ha-dashboard: serves a modern dashboard and bridges it to Home Assistant.
// The HA token lives only here (server side) and is never sent to browsers.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- configuration ----------
const HA_URL = (process.env.HA_URL || 'http://192.168.50.29:8123').replace(/\/+$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
const PORT = Number(process.env.PORT) || 8090;
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.READ_ONLY || '');
// Locks and alarms are deliberately NOT controllable by default.
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS ||
  'light,switch,fan,input_boolean,cover,climate,media_player,scene,script,button,vacuum')
  .split(',').map(s => s.trim()).filter(Boolean);
const EXCLUDE = process.env.EXCLUDE_ENTITIES ? new RegExp(process.env.EXCLUDE_ENTITIES) : null;

if (!HA_TOKEN) {
  console.error('HA_TOKEN is not set. Create a long-lived token in HA (Profile > Security) and set it in the stack.');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Domains the dashboard shows at all.
const SHOWN_DOMAINS = new Set([
  'light', 'switch', 'fan', 'input_boolean', 'cover', 'climate', 'media_player',
  'sensor', 'binary_sensor', 'camera', 'lock', 'vacuum', 'person', 'weather',
  'scene', 'script', 'button', 'alarm_control_panel', 'device_tracker',
]);

// What each domain may do, and which data keys a browser may send.
const SERVICES = {
  light: ['toggle', 'turn_on', 'turn_off'],
  switch: ['toggle', 'turn_on', 'turn_off'],
  fan: ['toggle', 'turn_on', 'turn_off'],
  input_boolean: ['toggle', 'turn_on', 'turn_off'],
  cover: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'],
  climate: ['set_temperature', 'set_hvac_mode', 'turn_on', 'turn_off'],
  media_player: ['media_play_pause', 'media_next_track', 'media_previous_track', 'volume_set', 'toggle'],
  scene: ['turn_on'],
  script: ['turn_on'],
  button: ['press'],
  vacuum: ['start', 'pause', 'return_to_base'],
  lock: ['lock', 'unlock'],
};
const DATA_KEYS = new Set(['brightness_pct', 'temperature', 'hvac_mode', 'position', 'volume_level']);

// ---------- state ----------
const store = {
  ready: false,
  config: {},
  areas: new Map(),        // area_id -> name
  deviceArea: new Map(),   // device_id -> area_id
  entityReg: new Map(),    // entity_id -> registry entry
  states: new Map(),       // entity_id -> HA state object
};

function areaOf(entityId) {
  const reg = store.entityReg.get(entityId);
  if (!reg) return null;
  return reg.area_id || store.deviceArea.get(reg.device_id) || null;
}

function isShown(entityId) {
  const domain = entityId.split('.')[0];
  if (!SHOWN_DOMAINS.has(domain)) return false;
  if (EXCLUDE && EXCLUDE.test(entityId)) return false;
  const reg = store.entityReg.get(entityId);
  if (reg && (reg.hidden_by || reg.disabled_by || reg.entity_category)) return false;
  return true;
}

// Strip anything a browser shouldn't see (entity_picture carries HA access tokens).
function publicEntity(s) {
  const { entity_picture, access_token, ...attributes } = s.attributes || {};
  return {
    entity_id: s.entity_id,
    state: s.state,
    attributes,
    area_id: areaOf(s.entity_id),
    picture: entity_picture ? createHash('sha1').update(entity_picture).digest('hex').slice(0, 10) : null,
    last_changed: s.last_changed,
  };
}

function snapshot() {
  const entities = [];
  for (const s of store.states.values()) if (isShown(s.entity_id)) entities.push(publicEntity(s));
  return {
    type: 'snapshot',
    config: {
      location_name: store.config.location_name || 'Home',
      unit_system: store.config.unit_system || {},
      read_only: READ_ONLY,
      allowed_domains: READ_ONLY ? [] : ALLOWED_DOMAINS,
    },
    areas: [...store.areas].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    entities,
  };
}

// ---------- Home Assistant client ----------
class HAClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.backoff = 1000;
    this.registryTimer = null;
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
      }, 15000);
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

  async loadRegistries() {
    const [areas, devices, entities] = await Promise.all([
      this.send({ type: 'config/area_registry/list' }),
      this.send({ type: 'config/device_registry/list' }),
      this.send({ type: 'config/entity_registry/list' }),
    ]);
    store.areas = new Map(areas.map(a => [a.area_id, a.name]));
    store.deviceArea = new Map(devices.filter(d => d.area_id).map(d => [d.id, d.area_id]));
    store.entityReg = new Map(entities.map(e => [e.entity_id, e]));
  }

  async init() {
    const [config, states] = await Promise.all([
      this.send({ type: 'get_config' }),
      this.send({ type: 'get_states' }),
      this.loadRegistries(),
    ]);
    store.config = config;
    store.states = new Map(states.map(s => [s.entity_id, s]));
    for (const event_type of ['state_changed', 'area_registry_updated', 'device_registry_updated', 'entity_registry_updated']) {
      await this.send({ type: 'subscribe_events', event_type });
    }
    store.ready = true;
    this.setConnected(true);
    log(`Loaded ${store.states.size} entities, ${store.areas.size} areas`);
    broadcast(snapshot());
  }

  onEvent(ev) {
    if (ev.event_type === 'state_changed') {
      const { entity_id, new_state } = ev.data;
      if (!new_state) {
        store.states.delete(entity_id);
        broadcast({ type: 'removed', entity_id });
        return;
      }
      store.states.set(entity_id, new_state);
      if (isShown(entity_id)) broadcast({ type: 'state', entity: publicEntity(new_state) });
    } else {
      // Registry changed (area renamed, entity moved...): reload and resend, debounced.
      clearTimeout(this.registryTimer);
      this.registryTimer = setTimeout(async () => {
        try { await this.loadRegistries(); broadcast(snapshot()); }
        catch (err) { log('Registry reload failed:', err.message); }
      }, 1000);
    }
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
  if (typeof entity_id !== 'string' || entity_id.split('.')[0] !== domain || !store.states.has(entity_id)) {
    throw new Error('unknown entity');
  }
  const service_data = {};
  for (const [k, v] of Object.entries(msg.data || {})) {
    if (!DATA_KEYS.has(k)) continue;
    if (k === 'hvac_mode') {
      if (typeof v === 'string' && /^[a-z_]+$/.test(v)) service_data[k] = v;
    } else if (Number.isFinite(v)) {
      service_data[k] = v;
    }
  }
  await ha.send({ type: 'call_service', domain, service, service_data, target: { entity_id } });
}

// ---------- HTTP ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MDI_DIR = path.join(__dirname, 'node_modules', '@mdi', 'font');
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
      'Cache-Control': root === MDI_DIR ? 'public, max-age=604800' : 'no-cache',
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

// Proxies an entity's picture (camera snapshot, album art, person photo) using the server-side token.
async function servePicture(res, entityId) {
  const s = store.states.get(entityId);
  const pic = s?.attributes?.entity_picture;
  if (!s || !isShown(entityId) || typeof pic !== 'string' || !pic.startsWith('/')) return notFound(res);
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
  const p = decodeURIComponent(url.pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  if (p === '/healthz') {
    res.writeHead(ha.connected ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: ha.connected, entities: store.states.size }));
  }
  if (p.startsWith('/api/picture/')) return servePicture(res, p.slice('/api/picture/'.length));
  if (p.startsWith('/mdi/')) return serveFile(res, MDI_DIR, p.slice('/mdi/'.length));
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

server.listen(PORT, () => {
  log(`ha-dashboard listening on :${PORT} (HA: ${HA_URL}, read-only: ${READ_ONLY})`);
  ha.connect();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log('Shutting down'); server.close(); process.exit(0); });
}
