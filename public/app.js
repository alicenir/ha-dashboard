'use strict';

// ---------- state ----------
const S = {
  entities: new Map(),
  areas: [],
  config: { allowed_domains: [], read_only: true, location_name: 'Home' },
  filter: 'all',
  connected: false,
  dragging: null,          // entity_id of a slider being dragged
  dirtyAreas: new Set(),
  flushTimer: null,
  pendingTemp: new Map(),  // climate entity -> { value, timer }
  camTick: Date.now(),
  collapsed: loadCollapsed(),
};

const NONE = '__none__';
const GLOBAL_DOMAINS = new Set(['weather', 'person', 'device_tracker']);
const ROOM_SENSOR_CLASSES = new Set(['temperature', 'humidity', 'co2', 'carbon_dioxide', 'pm25', 'illuminance', 'power', 'aqi']);
const ROOM_BINARY_CLASSES = new Set(['door', 'window', 'opening', 'garage_door', 'motion', 'occupancy', 'presence', 'moisture', 'smoke', 'gas']);
const ORDER = ['climate', 'light', 'switch', 'fan', 'input_boolean', 'cover', 'media_player', 'vacuum', 'lock', 'alarm_control_panel', 'camera', 'scene', 'script', 'button'];

const $ = sel => document.querySelector(sel);
const domain = id => id.split('.')[0];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const canControl = d => !S.config.read_only && S.config.allowed_domains.includes(d);
const isUnavailable = e => e.state === 'unavailable' || e.state === 'unknown';

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('collapsed') || `["${'__none__'}"]`)); }
  catch { return new Set(['__none__']); }
}
function saveCollapsed() {
  try { localStorage.setItem('collapsed', JSON.stringify([...S.collapsed])); } catch { /* storage unavailable */ }
}

// ---------- connection ----------
let ws;
let backoff = 1000;
let callRef = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { backoff = 1000; };
  ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    setOnline(false, 'Dashboard connection lost, reconnecting…');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
}

function handle(m) {
  switch (m.type) {
    case 'snapshot':
      S.config = m.config;
      S.areas = m.areas;
      S.entities = new Map(m.entities.map(e => [e.entity_id, e]));
      document.title = S.config.location_name;
      setOnline(true);
      renderAll();
      break;
    case 'state': {
      const prev = S.entities.get(m.entity.entity_id);
      S.entities.set(m.entity.entity_id, m.entity);
      markDirty(prev, m.entity);
      break;
    }
    case 'removed': {
      const prev = S.entities.get(m.entity_id);
      S.entities.delete(m.entity_id);
      markDirty(prev, null);
      break;
    }
    case 'ha_status':
      setOnline(m.connected, m.connected ? '' : 'Home Assistant is unreachable, retrying…');
      break;
    case 'call_result':
      if (!m.ok) toast(m.error || 'Action failed');
      break;
  }
}

function setOnline(ok, text) {
  S.connected = ok;
  $('#offline').hidden = ok;
  if (text) $('#offline-text').textContent = text;
}

function call(d, service, entity_id, data) {
  if (!canControl(d)) return toast('This control is disabled on the dashboard');
  if (!ws || ws.readyState !== WebSocket.OPEN) return toast('Not connected');
  ws.send(JSON.stringify({ type: 'call', ref: ++callRef, domain: d, service, entity_id, data }));
}

// Batch re-renders: sensors can update many times a second.
function markDirty(prev, next) {
  for (const e of [prev, next]) if (e) S.dirtyAreas.add(e.area_id || NONE);
  if (!S.flushTimer) S.flushTimer = setTimeout(flush, 250);
}

function flush() {
  S.flushTimer = null;
  if (S.dragging) { S.flushTimer = setTimeout(flush, 250); return; }
  renderHeader();
  for (const areaId of S.dirtyAreas) renderRoom(areaId);
  S.dirtyAreas.clear();
}

// ---------- helpers ----------
function areaName(id) {
  return id === NONE ? 'Other' : (S.areas.find(a => a.id === id)?.name || 'Other');
}

function displayName(e) {
  let name = e.attributes.friendly_name || e.entity_id.split('.')[1].replace(/_/g, ' ');
  const area = e.area_id ? areaName(e.area_id) : '';
  if (area && name.toLowerCase().startsWith(area.toLowerCase() + ' ') && name.length > area.length + 1) {
    name = name.slice(area.length + 1);
    name = name.charAt(0).toUpperCase() + name.slice(1);
  }
  return name;
}

function fmtNum(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return v;
  return Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, '');
}

function sensorValue(e) {
  if (domain(e.entity_id) === 'binary_sensor') return binaryText(e);
  const unit = e.attributes.unit_of_measurement || '';
  const v = fmtNum(e.state);
  return unit ? `${v}${/^°|%$/.test(unit) ? '' : ' '}${unit}` : v;
}

function binaryText(e) {
  const on = e.state === 'on';
  switch (e.attributes.device_class) {
    case 'door': case 'window': case 'opening': case 'garage_door': return on ? 'Open' : 'Closed';
    case 'motion': case 'occupancy': case 'presence': return on ? 'Detected' : 'Clear';
    case 'moisture': return on ? 'Wet' : 'Dry';
    case 'smoke': case 'gas': case 'problem': case 'safety': return on ? 'Alert' : 'OK';
    case 'connectivity': return on ? 'Connected' : 'Offline';
    case 'battery': return on ? 'Low' : 'OK';
    case 'lock': return on ? 'Unlocked' : 'Locked';
    case 'plug': case 'power': return on ? 'On' : 'Off';
    default: return on ? 'On' : 'Off';
  }
}

function isAlert(e) {
  if (domain(e.entity_id) !== 'binary_sensor' || e.state !== 'on') return false;
  return ['door', 'window', 'opening', 'garage_door', 'moisture', 'smoke', 'gas', 'problem', 'safety'].includes(e.attributes.device_class);
}

function icon(e) {
  if (e.attributes.icon?.startsWith('mdi:')) return 'mdi-' + e.attributes.icon.slice(4);
  const d = domain(e.entity_id);
  const on = e.state === 'on';
  const dc = e.attributes.device_class;
  switch (d) {
    case 'light': return on ? 'mdi-lightbulb' : 'mdi-lightbulb-outline';
    case 'switch': return dc === 'outlet' ? 'mdi-power-socket-eu' : (on ? 'mdi-toggle-switch' : 'mdi-toggle-switch-off-outline');
    case 'input_boolean': return on ? 'mdi-toggle-switch' : 'mdi-toggle-switch-off-outline';
    case 'fan': return on ? 'mdi-fan' : 'mdi-fan-off';
    case 'cover': return e.state === 'closed' ? 'mdi-window-shutter' : 'mdi-window-shutter-open';
    case 'climate': return e.state === 'cool' ? 'mdi-snowflake' : e.state === 'heat' ? 'mdi-fire' : 'mdi-thermostat';
    case 'media_player': return e.attributes.device_class === 'tv' ? 'mdi-television' : 'mdi-speaker';
    case 'camera': return 'mdi-cctv';
    case 'scene': return 'mdi-palette-outline';
    case 'script': return 'mdi-script-text-play-outline';
    case 'button': return 'mdi-gesture-tap-button';
    case 'lock': return e.state === 'locked' ? 'mdi-lock' : 'mdi-lock-open-variant';
    case 'vacuum': return 'mdi-robot-vacuum';
    case 'alarm_control_panel': return 'mdi-shield-home';
    case 'binary_sensor': return {
      door: on ? 'mdi-door-open' : 'mdi-door-closed',
      garage_door: on ? 'mdi-garage-open' : 'mdi-garage',
      window: on ? 'mdi-window-open-variant' : 'mdi-window-closed-variant',
      opening: on ? 'mdi-square-outline' : 'mdi-square',
      motion: on ? 'mdi-motion-sensor' : 'mdi-motion-sensor-off',
      occupancy: on ? 'mdi-home-account' : 'mdi-home-outline',
      presence: on ? 'mdi-home-account' : 'mdi-home-outline',
      moisture: on ? 'mdi-water-alert' : 'mdi-water-off',
      smoke: on ? 'mdi-smoke-detector-alert' : 'mdi-smoke-detector',
      connectivity: on ? 'mdi-lan-connect' : 'mdi-lan-disconnect',
    }[dc] || (on ? 'mdi-checkbox-marked-circle' : 'mdi-checkbox-blank-circle-outline');
    case 'sensor': return {
      temperature: 'mdi-thermometer', humidity: 'mdi-water-percent', power: 'mdi-flash',
      energy: 'mdi-lightning-bolt', battery: 'mdi-battery', illuminance: 'mdi-brightness-5',
      pressure: 'mdi-gauge', co2: 'mdi-molecule-co2', carbon_dioxide: 'mdi-molecule-co2',
      pm25: 'mdi-air-filter', voltage: 'mdi-sine-wave', current: 'mdi-current-ac',
      distance: 'mdi-map-marker-distance', speed: 'mdi-speedometer', timestamp: 'mdi-clock-outline',
    }[dc] || 'mdi-eye-outline';
    default: return 'mdi-help-circle-outline';
  }
}

function weatherIcon(cond) {
  return {
    'clear-night': 'mdi-weather-night', cloudy: 'mdi-weather-cloudy', fog: 'mdi-weather-fog',
    hail: 'mdi-weather-hail', lightning: 'mdi-weather-lightning', 'lightning-rainy': 'mdi-weather-lightning-rainy',
    partlycloudy: 'mdi-weather-partly-cloudy', pouring: 'mdi-weather-pouring', rainy: 'mdi-weather-rainy',
    snowy: 'mdi-weather-snowy', 'snowy-rainy': 'mdi-weather-snowy-rainy', sunny: 'mdi-weather-sunny',
    windy: 'mdi-weather-windy', 'windy-variant': 'mdi-weather-windy-variant', exceptional: 'mdi-alert-circle-outline',
  }[cond] || 'mdi-weather-partly-cloudy';
}

function category(e) {
  const d = domain(e.entity_id);
  if (d === 'light') return 'light';
  if (d === 'climate') return 'climate';
  if (d === 'media_player') return 'media';
  if (d === 'camera') return 'camera';
  if (d === 'sensor' || d === 'binary_sensor') return 'sensor';
  return 'control';
}

function isRoomSensor(e) {
  const dc = e.attributes.device_class;
  return domain(e.entity_id) === 'sensor' ? ROOM_SENSOR_CLASSES.has(dc) : ROOM_BINARY_CLASSES.has(dc);
}

// ---------- tiles ----------
function tileShell(e, { cls = '', active = false, clickable = false, action = '', body }) {
  const d = domain(e.entity_id);
  const classes = ['tile', `t-${d}`, cls, active && 'active', clickable && 'clickable', isUnavailable(e) && 'unavailable']
    .filter(Boolean).join(' ');
  return `<div class="${classes}" data-id="${esc(e.entity_id)}"${action ? ` data-action="${action}"` : ''}>${body}</div>`;
}

const iconBox = e => `<div class="icon"><span class="mdi ${icon(e)}"></span></div>`;

function toggleTile(e) {
  const d = domain(e.entity_id);
  const on = e.state === 'on';
  const ctl = canControl(d) && !isUnavailable(e);
  let stateText = isUnavailable(e) ? 'Unavailable' : on ? 'On' : 'Off';
  let slider = '';
  if (d === 'light') {
    const modes = e.attributes.supported_color_modes || [];
    const dimmable = modes.some(m => m !== 'onoff');
    const pct = on && e.attributes.brightness ? Math.max(1, Math.round(e.attributes.brightness / 2.55)) : 0;
    if (on && pct) stateText = `${pct}%`;
    if (dimmable && ctl && on) {
      slider = `<input type="range" class="slider" min="1" max="100" value="${pct || 1}" data-pct="${pct}" data-action="brightness" aria-label="Brightness">`;
    }
  }
  return tileShell(e, {
    active: on, clickable: ctl, action: ctl ? 'toggle' : '',
    body: `${iconBox(e)}<div><div class="name">${esc(displayName(e))}</div><div class="state">${stateText}</div></div>${slider}`,
  });
}

function climateTile(e) {
  const a = e.attributes;
  const ctl = canControl('climate') && !isUnavailable(e);
  const pending = S.pendingTemp.get(e.entity_id);
  const target = pending ? pending.value : a.temperature;
  const unit = a.temperature_unit || (S.config.unit_system?.temperature) || '°';
  const cur = a.current_temperature != null ? fmtNum(a.current_temperature) : '–';
  const mode = e.state;
  const modeLabel = { off: 'Off', heat: 'Heating', cool: 'Cooling', heat_cool: 'Auto', auto: 'Auto', dry: 'Dry', fan_only: 'Fan' }[mode] || mode;
  const act = a.hvac_action;
  const action = act && !['idle', 'off'].includes(act) && !modeLabel.toLowerCase().startsWith(act) ? ` · ${act}` : '';
  const modes = (a.hvac_modes || []).map(m =>
    `<button data-action="hvac" data-mode="${esc(m)}" class="${m === mode ? 'on' : ''}"${ctl ? '' : ' disabled'}>${esc({ heat_cool: 'auto', fan_only: 'fan' }[m] || m)}</button>`).join('');
  const targetHtml = target != null ? `
      <div class="target">
        <button class="rb" data-action="temp-down"${ctl ? '' : ' disabled'} aria-label="Lower"><span class="mdi mdi-minus"></span></button>
        <span class="tv">${fmtNum(target)}°</span>
        <button class="rb" data-action="temp-up"${ctl ? '' : ' disabled'} aria-label="Raise"><span class="mdi mdi-plus"></span></button>
      </div>` : '';
  return tileShell(e, {
    cls: `wide ${mode}`, active: mode !== 'off' && !isUnavailable(e),
    body: `
      <div class="row">${iconBox(e)}<div class="state">${esc(modeLabel)}${esc(action)}</div></div>
      <div class="row">
        <div><div class="big">${cur}<small>${esc(unit)}</small></div><div class="name">${esc(displayName(e))}</div></div>
        ${targetHtml}
      </div>
      <div class="modes">${modes}</div>`,
  });
}

function coverTile(e) {
  const ctl = canControl('cover') && !isUnavailable(e);
  const pos = e.attributes.current_position;
  const stateText = isUnavailable(e) ? 'Unavailable' : pos != null && e.state === 'open' ? `Open · ${pos}%` : e.state.charAt(0).toUpperCase() + e.state.slice(1);
  const dis = ctl ? '' : ' disabled';
  return tileShell(e, {
    active: e.state === 'open' || e.state === 'opening',
    body: `
      <div class="row">${iconBox(e)}
        <div class="btns">
          <button class="rb" data-action="cover-open"${dis} aria-label="Open"><span class="mdi mdi-chevron-up"></span></button>
          <button class="rb" data-action="cover-stop"${dis} aria-label="Stop"><span class="mdi mdi-stop"></span></button>
          <button class="rb" data-action="cover-close"${dis} aria-label="Close"><span class="mdi mdi-chevron-down"></span></button>
        </div>
      </div>
      <div><div class="name">${esc(displayName(e))}</div><div class="state">${esc(stateText)}</div></div>`,
  });
}

function mediaTile(e) {
  const a = e.attributes;
  const ctl = canControl('media_player') && !isUnavailable(e);
  const playing = e.state === 'playing';
  const track = [a.media_title, a.media_artist].filter(Boolean).join(' — ');
  const art = e.picture && (playing || e.state === 'paused')
    ? `<div class="art" data-bg="/api/picture/${encodeURIComponent(e.entity_id)}?v=${e.picture}"></div>` : '';
  const dis = ctl ? '' : ' disabled';
  const controls = ['playing', 'paused', 'idle', 'on'].includes(e.state) ? `
      <div class="btns">
        <button class="rb" data-action="media-prev"${dis} aria-label="Previous"><span class="mdi mdi-skip-previous"></span></button>
        <button class="rb" data-action="media-play"${dis} aria-label="Play or pause"><span class="mdi ${playing ? 'mdi-pause' : 'mdi-play'}"></span></button>
        <button class="rb" data-action="media-next"${dis} aria-label="Next"><span class="mdi mdi-skip-next"></span></button>
      </div>` : '';
  const stateText = isUnavailable(e) ? 'Unavailable' : e.state.charAt(0).toUpperCase() + e.state.slice(1);
  return tileShell(e, {
    cls: playing || e.state === 'paused' ? 'wide' : '', active: playing,
    body: `${art}
      <div class="row">${iconBox(e)}${controls}</div>
      <div><div class="name">${esc(displayName(e))}</div>
      <div class="track">${esc(track || (a.source ? a.source : stateText))}</div></div>`,
  });
}

function cameraTile(e) {
  const src = `/api/picture/${encodeURIComponent(e.entity_id)}?t=${S.camTick}`;
  return `<div class="tile t-camera wide clickable" data-id="${esc(e.entity_id)}" data-action="cam-refresh">
    <img alt="" loading="lazy" src="${src}" data-cam="${esc(e.entity_id)}">
    <div class="cam-label"><span class="live"></span>${esc(displayName(e))}</div></div>`;
}

function actionTile(e) {
  const d = domain(e.entity_id);
  const ctl = canControl(d) && !isUnavailable(e);
  return tileShell(e, {
    clickable: ctl, action: ctl ? 'activate' : '',
    body: `${iconBox(e)}<div class="name">${esc(displayName(e))}</div>`,
  });
}

function lockTile(e) {
  const ctl = canControl('lock') && !isUnavailable(e);
  return tileShell(e, {
    active: e.state === 'unlocked', clickable: ctl, action: ctl ? 'lock' : '',
    body: `${iconBox(e)}<div><div class="name">${esc(displayName(e))}</div><div class="state">${esc(e.state)}</div></div>`,
  });
}

function vacuumTile(e) {
  const ctl = canControl('vacuum') && !isUnavailable(e);
  const dis = ctl ? '' : ' disabled';
  return tileShell(e, {
    active: e.state === 'cleaning',
    body: `
      <div class="row">${iconBox(e)}
        <div class="btns">
          <button class="rb" data-action="vac-start"${dis} aria-label="Start"><span class="mdi mdi-play"></span></button>
          <button class="rb" data-action="vac-dock"${dis} aria-label="Dock"><span class="mdi mdi-home-import-outline"></span></button>
        </div>
      </div>
      <div><div class="name">${esc(displayName(e))}</div><div class="state">${esc(e.state)}</div></div>`,
  });
}

function genericTile(e) {
  return tileShell(e, {
    body: `${iconBox(e)}<div><div class="name">${esc(displayName(e))}</div><div class="state">${esc(e.state)}</div></div>`,
  });
}

function renderTile(e) {
  switch (domain(e.entity_id)) {
    case 'light': case 'switch': case 'fan': case 'input_boolean': return toggleTile(e);
    case 'climate': return climateTile(e);
    case 'cover': return coverTile(e);
    case 'media_player': return mediaTile(e);
    case 'camera': return cameraTile(e);
    case 'scene': case 'script': case 'button': return actionTile(e);
    case 'lock': return lockTile(e);
    case 'vacuum': return vacuumTile(e);
    default: return genericTile(e);
  }
}

function sensorChip(e) {
  return `<span class="chip sensor-chip${isAlert(e) ? ' warn' : ''}" data-id="${esc(e.entity_id)}" title="${esc(e.entity_id)}">
    <span class="mdi ${icon(e)}"></span><span class="val">${esc(sensorValue(e))}</span><span class="lbl">${esc(displayName(e))}</span></span>`;
}

// ---------- rooms ----------
function roomEntities(areaId) {
  const list = [];
  for (const e of S.entities.values()) {
    if (GLOBAL_DOMAINS.has(domain(e.entity_id))) continue;
    if ((e.area_id || NONE) !== areaId) continue;
    list.push(e);
  }
  return list;
}

function roomHtml(areaId) {
  const all = roomEntities(areaId);
  const f = S.filter;
  const sensors = all.filter(e => category(e) === 'sensor' && !isUnavailable(e) &&
    (f === 'sensor' || (f === 'all' && isRoomSensor(e))));
  const tiles = f === 'sensor' ? [] : all.filter(e => {
    const c = category(e);
    return c !== 'sensor' && (f === 'all' || c === f);
  });
  if (!sensors.length && !tiles.length) return '';

  tiles.sort((a, b) => {
    const oa = ORDER.indexOf(domain(a.entity_id)), ob = ORDER.indexOf(domain(b.entity_id));
    return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob) || displayName(a).localeCompare(displayName(b));
  });
  sensors.sort((a, b) => (isAlert(b) - isAlert(a)) || displayName(a).localeCompare(displayName(b)));

  const lightsOn = all.filter(e => domain(e.entity_id) === 'light' && e.state === 'on').length;
  const temp = all.find(e => e.attributes.device_class === 'temperature' && domain(e.entity_id) === 'sensor' && !isUnavailable(e));
  const meta = [temp && sensorValue(temp), lightsOn && `${lightsOn} light${lightsOn > 1 ? 's' : ''} on`].filter(Boolean).join(' · ');
  const open = f !== 'all' || !S.collapsed.has(areaId);

  return `<details class="room" data-area="${esc(areaId)}"${open ? ' open' : ''}>
    <summary><h2>${esc(areaName(areaId))}</h2><span class="room-meta">${esc(meta)}</span><span class="caret mdi mdi-chevron-down"></span></summary>
    ${sensors.length ? `<div class="sensors">${sensors.map(sensorChip).join('')}</div>` : ''}
    ${tiles.length ? `<div class="grid">${tiles.map(renderTile).join('')}</div>` : ''}
  </details>`;
}

function roomOrder() {
  const ids = S.areas.map(a => a.id);
  ids.push(NONE);
  return ids;
}

function renderAll() {
  renderHeader();
  const html = roomOrder().map(roomHtml).join('');
  const rooms = $('#rooms');
  rooms.innerHTML = html || `<div class="empty">Nothing to show here yet.</div>`;
  applyDynamicStyles(rooms);
}

function renderRoom(areaId) {
  const existing = document.querySelector(`.room[data-area="${CSS.escape(areaId)}"]`);
  const html = roomHtml(areaId);
  if (!existing) { if (html) renderAll(); return; }
  if (!html) { existing.remove(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const fresh = tmp.firstElementChild;
  fresh.open = existing.open;
  existing.replaceWith(fresh);
  applyDynamicStyles(fresh);
}

// CSP blocks inline style attributes, so dynamic styles are applied through the CSSOM.
function applyDynamicStyles(root) {
  root.querySelectorAll('[data-pct]').forEach(n => n.style.setProperty('--pct', `${n.dataset.pct}%`));
  root.querySelectorAll('[data-bg]').forEach(n => { n.style.backgroundImage = `url("${n.dataset.bg}")`; });
}

// ---------- header ----------
function renderHeader() {
  const all = [...S.entities.values()];

  const w = all.find(e => domain(e.entity_id) === 'weather' && !isUnavailable(e));
  const wb = $('#weather');
  if (w) {
    wb.hidden = false;
    const unit = w.attributes.temperature_unit || '°';
    wb.innerHTML = `<div><div class="temp">${fmtNum(w.attributes.temperature)}${esc(unit)}</div>
      <div class="cond">${esc(w.state.replace(/-/g, ' ').replace('partlycloudy', 'partly cloudy'))}</div></div>
      <span class="mdi ${weatherIcon(w.state)}"></span>`;
  } else {
    wb.hidden = true;
  }

  const people = all.filter(e => domain(e.entity_id) === 'person');
  const pb = $('#people');
  pb.innerHTML = people.map(p => {
    const name = p.attributes.friendly_name || p.entity_id.split('.')[1];
    const home = p.state === 'home';
    const where = home ? 'Home' : p.state === 'not_home' ? 'Away' : p.state;
    const pic = p.picture ? ` data-bg="/api/picture/${encodeURIComponent(p.entity_id)}?v=${p.picture}"` : '';
    return `<span class="chip person${home ? ' home' : ''}"><span class="avatar"${pic}>${p.picture ? '' : esc(name.charAt(0).toUpperCase())}</span>
      ${esc(name)} <span class="where">${esc(where)}</span></span>`;
  }).join('');
  applyDynamicStyles(pb);

  const lightsOn = all.filter(e => domain(e.entity_id) === 'light' && e.state === 'on').length;
  const openings = all.filter(isAlert).length;
  const motion = all.filter(e => domain(e.entity_id) === 'binary_sensor' && e.state === 'on' &&
    ['motion', 'occupancy', 'presence'].includes(e.attributes.device_class)).length;
  const playing = all.filter(e => domain(e.entity_id) === 'media_player' && e.state === 'playing').length;
  const hvac = all.filter(e => domain(e.entity_id) === 'climate' && e.state !== 'off' && !isUnavailable(e)).length;

  const chips = [
    lightsOn && `<span class="chip hot"><span class="mdi mdi-lightbulb-group"></span>${lightsOn} light${lightsOn > 1 ? 's' : ''} on</span>`,
    hvac && `<span class="chip good"><span class="mdi mdi-thermostat"></span>${hvac} climate running</span>`,
    openings && `<span class="chip warn"><span class="mdi mdi-alert-circle-outline"></span>${openings} open / alert</span>`,
    motion && `<span class="chip"><span class="mdi mdi-motion-sensor"></span>Motion in ${motion}</span>`,
    playing && `<span class="chip good"><span class="mdi mdi-music"></span>${playing} playing</span>`,
  ].filter(Boolean);
  $('#summary').innerHTML = chips.join('');
}

function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  $('#date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const h = now.getHours();
  $('#greeting').textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ---------- interaction ----------
function entityOf(el) {
  const id = el.closest('[data-id]')?.dataset.id;
  return id ? S.entities.get(id) : null;
}

function nudgeTemp(e, dir) {
  const a = e.attributes;
  const step = a.target_temp_step || (String(a.temperature_unit || '').includes('F') ? 1 : 0.5);
  const cur = S.pendingTemp.get(e.entity_id)?.value ?? a.temperature;
  if (cur == null) return;
  let next = Math.round((cur + dir * step) * 10) / 10;
  if (a.min_temp != null) next = Math.max(a.min_temp, next);
  if (a.max_temp != null) next = Math.min(a.max_temp, next);
  const prev = S.pendingTemp.get(e.entity_id);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    S.pendingTemp.delete(e.entity_id);
    call('climate', 'set_temperature', e.entity_id, { temperature: next });
  }, 700);
  S.pendingTemp.set(e.entity_id, { value: next, timer });
  renderRoom(e.area_id || NONE);
}

document.addEventListener('click', ev => {
  const filterBtn = ev.target.closest('[data-filter]');
  if (filterBtn) {
    S.filter = filterBtn.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('on', b === filterBtn));
    renderAll();
    return;
  }
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const e = entityOf(el);
  if (!e) return;
  const d = domain(e.entity_id);
  const id = e.entity_id;
  switch (el.dataset.action) {
    case 'toggle': call(d, 'toggle', id); break;
    case 'brightness': break; // handled on change
    case 'activate': call(d, d === 'button' ? 'press' : 'turn_on', id); toast(`${displayName(e)} activated`); break;
    case 'temp-up': nudgeTemp(e, +1); break;
    case 'temp-down': nudgeTemp(e, -1); break;
    case 'hvac': call('climate', 'set_hvac_mode', id, { hvac_mode: el.dataset.mode }); break;
    case 'cover-open': call('cover', 'open_cover', id); break;
    case 'cover-stop': call('cover', 'stop_cover', id); break;
    case 'cover-close': call('cover', 'close_cover', id); break;
    case 'media-play': call('media_player', 'media_play_pause', id); break;
    case 'media-prev': call('media_player', 'media_previous_track', id); break;
    case 'media-next': call('media_player', 'media_next_track', id); break;
    case 'vac-start': call('vacuum', 'start', id); break;
    case 'vac-dock': call('vacuum', 'return_to_base', id); break;
    case 'lock': {
      const unlock = e.state === 'locked';
      if (confirm(`${unlock ? 'Unlock' : 'Lock'} ${displayName(e)}?`)) call('lock', unlock ? 'unlock' : 'lock', id);
      break;
    }
    case 'cam-refresh': refreshCameras(); break;
  }
});

document.addEventListener('input', ev => {
  const el = ev.target;
  if (el.dataset?.action !== 'brightness') return;
  const e = entityOf(el);
  if (!e) return;
  S.dragging = e.entity_id;
  el.style.setProperty('--pct', `${el.value}%`);
  const state = el.closest('.tile')?.querySelector('.state');
  if (state) state.textContent = `${el.value}%`;
});

document.addEventListener('change', ev => {
  const el = ev.target;
  if (el.dataset?.action !== 'brightness') return;
  const e = entityOf(el);
  if (e) call('light', 'turn_on', e.entity_id, { brightness_pct: Number(el.value) });
  setTimeout(() => { S.dragging = null; }, 300);
});

// Remember which rooms are collapsed (only in the "Rooms" view).
$('#rooms').addEventListener('toggle', ev => {
  const d = ev.target;
  if (!d.matches?.('.room') || S.filter !== 'all') return;
  d.open ? S.collapsed.delete(d.dataset.area) : S.collapsed.add(d.dataset.area);
  saveCollapsed();
}, true);

function refreshCameras() {
  S.camTick = Date.now();
  document.querySelectorAll('img[data-cam]').forEach(img => {
    img.src = `/api/picture/${encodeURIComponent(img.dataset.cam)}?t=${S.camTick}`;
  });
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

// ---------- start ----------
tickClock();
setInterval(tickClock, 15000);
setInterval(() => { if (!document.hidden) refreshCameras(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCameras(); });
connect();
