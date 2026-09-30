'use strict';

// ---------- state ----------
const S = {
  entities: new Map(),
  layout: {},
  config: { allowed_domains: [], read_only: true },
  forecast: { hourly: [], daily: [] },
  history: null,
  todo: [],
  connected: false,
  pendingLimit: null,      // { value, timer }
  renderTimer: null,
};

const $ = sel => document.querySelector(sel);
const domain = id => (id || '').split('.')[0];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const E = id => (id ? S.entities.get(id) || null : null);
const bad = e => !e || e.state === 'unavailable' || e.state === 'unknown';
const num = id => { const e = E(id); if (bad(e)) return null; const n = parseFloat(e.state); return Number.isFinite(n) ? n : null; };
const canControl = id => !!id && !S.config.read_only && S.config.allowed_domains.includes(domain(id)) && !!E(id);
const nameOf = (id, fallback) => fallback || E(id)?.attributes.friendly_name || (id || '').split('.')[1]?.replace(/_/g, ' ') || '';
const fmt = (v, d = 1) => (v == null ? '–' : Number.isInteger(v) || Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(d).replace(/\.0$/, ''));
const hhmm = d => d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });

const T = {
  days: ['יום א׳', 'יום ב׳', 'יום ג׳', 'יום ד׳', 'יום ה׳', 'יום ו׳', 'שבת'],
  cond: {
    sunny: 'שמשי', 'clear-night': 'לילה בהיר', partlycloudy: 'מעונן חלקית', cloudy: 'מעונן', rainy: 'גשום',
    pouring: 'גשם חזק', lightning: 'ברקים', 'lightning-rainy': 'סופת רעמים', snowy: 'שלג', 'snowy-rainy': 'שלג וגשם',
    fog: 'ערפל', hail: 'ברד', windy: 'רוחות', 'windy-variant': 'רוחות ועננים', exceptional: 'חריג',
  },
  states: {
    on: 'פועל', off: 'כבוי', idle: 'לא פעיל', running: 'פועל', drying: 'ייבוש', cooling: 'קירור', washing: 'כביסה',
    finished: 'הסתיים', paused: 'מושהה', unavailable: 'לא זמין', unknown: 'לא ידוע', home: 'בבית', not_home: 'בחוץ',
    playing: 'מנגן', standby: 'המתנה',
  },
  car: {
    online: 'ער', asleep: 'במצב שינה', offline: 'לא מקוון', driving: 'בנסיעה', charging: 'בטעינה',
    suspended: 'מושהה', updating: 'מתעדכן', parked: 'חונה',
  },
};
const stateText = s => T.states[s] || s;

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
    setConnected(false);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
}

function handle(m) {
  switch (m.type) {
    case 'snapshot':
      S.config = m.config;
      S.layout = m.layout || {};
      S.entities = new Map(m.entities.map(e => [e.entity_id, e]));
      S.forecast = m.forecast || { hourly: [], daily: [] };
      S.history = m.history;
      S.todo = m.todo || [];
      setConnected(true);
      renderAll();
      renderTasks();
      break;
    case 'state':
      S.entities.set(m.entity.entity_id, m.entity);
      scheduleRender();
      break;
    case 'forecast':
      S.forecast = { hourly: m.hourly || [], daily: m.daily || [] };
      renderWeather();
      break;
    case 'history':
      S.history = m;
      renderPower();
      break;
    case 'todo':
      S.todo = m.items || [];
      renderTasks();
      break;
    case 'ha_status':
      setConnected(m.connected);
      break;
    case 'call_result':
      if (!m.ok) toast(m.error || 'הפעולה נכשלה');
      break;
  }
}

function setConnected(ok) {
  if (S.connected === ok) return;
  S.connected = ok;
  renderStatus();
}

function call(d, service, entity_id, data) {
  if (!canControl(entity_id)) return toast('השליטה בפריט הזה כבויה');
  if (!ws || ws.readyState !== WebSocket.OPEN) return toast('אין חיבור');
  ws.send(JSON.stringify({ type: 'call', ref: ++callRef, domain: d, service, entity_id, data }));
}

function scheduleRender() {
  if (!S.renderTimer) S.renderTimer = setTimeout(() => { S.renderTimer = null; renderAll(); }, 200);
}

function renderAll() {
  renderStatus();
  renderPower();
  renderWeather();
  renderCar();
  renderControls();
  renderInfo();
}

// CSP blocks inline style attributes, so dynamic sizes are applied through the CSSOM.
function applyStyles(root) {
  root.querySelectorAll('[data-w]').forEach(n => { n.style.width = `${n.dataset.w}%`; });
  root.querySelectorAll('[data-s]').forEach(n => { n.style.insetInlineStart = `${n.dataset.s}%`; });
}

const hint = text => `<div class="hint">${text}</div>`;
const header = (icon, title, meta = '') =>
  `<div class="ph"><div class="pt"><span class="mdi mdi-${icon}"></span>${esc(title)}</div>${meta}</div>`;

// ---------- top bar ----------
function tickClock() {
  const now = new Date();
  $('#clock').textContent = hhmm(now);
  $('#date').textContent = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
}

function renderStatus() {
  const items = S.layout.status || [];
  const persons = items.filter(i => domain(i.entity) === 'person').length;
  const pills = [`<span class="pill${S.connected ? '' : ' bad'}"><span class="dot"></span>${S.connected ? 'מחובר' : 'מנותק'}</span>`];
  for (const it of items) {
    const e = E(it.entity);
    if (!e) continue;
    const d = domain(it.entity);
    let text, cls = '';
    if (d === 'person' || d === 'device_tracker') {
      const home = e.state === 'home';
      const where = home ? 'בבית' : e.state === 'not_home' ? 'בחוץ' : e.state;
      const bat = num(it.battery);
      text = [it.label ?? (persons > 1 ? e.attributes.friendly_name : null), where, bat != null && `${Math.round(bat)}%`].filter(Boolean).join(' · ');
      cls = home ? 'good' : '';
    } else if (d === 'binary_sensor') {
      text = it.label || e.attributes.friendly_name;
      cls = e.state === 'on' ? '' : 'warn';
    } else {
      const unit = e.attributes.unit_of_measurement || '';
      text = `${it.label ? it.label + ' · ' : ''}${bad(e) ? '–' : fmt(num(it.entity)) ?? e.state}${unit}`;
    }
    pills.push(`<span class="pill ${cls}"><span class="mdi mdi-${esc(it.icon || 'information-outline')}"></span>${esc(text)}</span>`);
  }
  $('#status').innerHTML = pills.join('');
}

// ---------- electricity ----------
function arc(cx, cy, r, a0, a1) {
  const p = a => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function gaugeSvg(v, breaker) {
  const max = Math.ceil((breaker * 1.2) / 10) * 10;
  const A0 = 135, SWEEP = 270, cx = 100, cy = 100, r = 78;
  const ang = x => A0 + SWEEP * Math.min(Math.max(x / max, 0), 1);
  const level = (v ?? 0) / breaker;
  const color = level < 0.6 ? 'var(--green)' : level < 0.85 ? 'var(--yellow)' : 'var(--red)';
  let ticks = '';
  for (let t = 0; t <= max; t += 10) {
    const a = ang(t) * Math.PI / 180;
    ticks += `<text class="tick" x="${(cx + 97 * Math.cos(a)).toFixed(1)}" y="${(cy + 97 * Math.sin(a) + 3).toFixed(1)}" text-anchor="middle">${t}</text>`;
  }
  const va = ang(v ?? 0);
  const na = va * Math.PI / 180;
  const needle = v == null ? '' :
    `<line x1="${(cx + 64 * Math.cos(na)).toFixed(1)}" y1="${(cy + 64 * Math.sin(na)).toFixed(1)}" x2="${(cx + 90 * Math.cos(na)).toFixed(1)}" y2="${(cy + 90 * Math.sin(na)).toFixed(1)}" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>`;
  return `<svg viewBox="0 0 200 176" dir="ltr" aria-hidden="true">
    <path d="${arc(cx, cy, r, A0, A0 + SWEEP)}" fill="none" stroke="var(--card-2)" stroke-width="12" stroke-linecap="round"/>
    <path d="${arc(cx, cy, r + 11, ang(breaker * 0.85), ang(max))}" fill="none" stroke="var(--red)" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>
    ${v > 0 ? `<path d="${arc(cx, cy, r, A0, va)}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round"/>` : ''}
    ${needle}${ticks}
  </svg>`;
}

function sparkSvg(values, peak, breaker) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '';
  const W = 300, H = 46, n = values.length - 1;
  const yMax = Math.max(peak, breaker * 0.4, 1) * 1.1;
  const xy = ([i, v]) => `${(i / n * W).toFixed(1)} ${(H - 2 - (v / yMax) * (H - 6)).toFixed(1)}`;
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${xy(p)}`).join(' ');
  const area = `${line} L${(pts.at(-1)[0] / n * W).toFixed(1)} ${H} L${(pts[0][0] / n * W).toFixed(1)} ${H} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" dir="ltr" aria-hidden="true">
    <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff6b4a" stop-opacity=".45"/><stop offset="1" stop-color="#ff6b4a" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#sg)"/>
    <path d="${line}" fill="none" stroke="#ff6b4a" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function statBox(label, id, fallbackUnit) {
  const e = E(id);
  if (!id) return '';
  const unit = e?.attributes.unit_of_measurement || fallbackUnit || '';
  return `<div class="stat"><div class="l">${esc(label)}</div><div class="v"><span class="num">${fmt(num(id))}</span><small>${esc(unit)}</small></div></div>`;
}

function renderPower() {
  const el = $('#p-power');
  const p = S.layout.power || {};
  if (!p.current && !p.power) {
    el.innerHTML = header('lightning-bolt', 'חשמל בבית') +
      hint('הגדירו את חיישני החשמל (<code>power.current</code>, <code>power.power</code>) בקובץ ההגדרות');
    return;
  }
  const amps = num(p.current);
  const watts = num(p.power);
  const level = (amps ?? 0) / p.breaker;
  const badge = amps == null ? '' : level < 0.6 ? '<span class="badge">תקין</span>' :
    level < 0.85 ? '<span class="badge warn">עומס גבוה</span>' : '<span class="badge bad">עומס יתר</span>';
  const h = S.history && S.history.entity === p.current ? S.history : null;
  const main = p.current
    ? `<div class="gauge">${gaugeSvg(amps, p.breaker)}
        <div class="center"><div class="amps num">${fmt(amps)}<small>A</small></div>
        ${watts != null ? `<div class="watts"><span class="num">${fmt(watts)}</span> וואט</div>` : ''}${badge}</div></div>`
    : `<div class="gauge"><div class="center"><div class="amps num">${fmt(watts)}<small>W</small></div></div></div>`;
  el.innerHTML = header('lightning-bolt', 'חשמל בבית', `<span class="meta">מפסק <span class="num">${p.breaker}A</span></span>`) +
    main +
    (h ? `<div class="spark">${sparkSvg(h.values, h.peak, p.breaker)}
      <div class="legend"><span>${h.hours} שעות אחרונות</span><span>שיא <b class="num">${fmt(h.peak)}A</b></span></div></div>` : '') +
    `<div class="stats">${statBox('היום', p.today, 'kWh')}${statBox('החודש', p.month, 'kWh')}${statBox('שקע הרכב', p.car_socket, 'W')}</div>`;
}

// ---------- weather ----------
function weatherIcon(cond) {
  return {
    'clear-night': 'weather-night', cloudy: 'weather-cloudy', fog: 'weather-fog', hail: 'weather-hail',
    lightning: 'weather-lightning', 'lightning-rainy': 'weather-lightning-rainy', partlycloudy: 'weather-partly-cloudy',
    pouring: 'weather-pouring', rainy: 'weather-rainy', snowy: 'weather-snowy', 'snowy-rainy': 'weather-snowy-rainy',
    sunny: 'weather-sunny', windy: 'weather-windy', 'windy-variant': 'weather-windy-variant', exceptional: 'alert-circle-outline',
  }[cond] || 'weather-partly-cloudy';
}

function renderWeather() {
  const el = $('#p-weather');
  const w = S.layout.weather || {};
  const e = E(w.entity);
  if (!e) { el.innerHTML = header('weather-partly-cloudy', 'מזג אוויר') + hint('לא נמצאה ישות מזג אוויר'); return; }
  const a = e.attributes;
  const src = w.source || (a.attribution || '').match(/([a-z0-9-]+\.[a-z]{2,})/i)?.[1] || '';
  const today = S.forecast.daily[0];
  const now = Date.now();

  const extras = [
    a.humidity != null && `<span><span class="mdi mdi-water-outline"></span> <span class="num">${Math.round(a.humidity)}%</span></span>`,
    a.wind_speed != null && `<span><span class="mdi mdi-weather-windy"></span> <span class="num">${Math.round(a.wind_speed)}</span> ${esc(a.wind_speed_unit === 'km/h' ? 'קמ״ש' : a.wind_speed_unit || '')}</span>`,
    a.uv_index != null && `<span><span class="mdi mdi-white-balance-sunny"></span> <span class="num">UV ${Math.round(a.uv_index)}</span></span>`,
  ].filter(Boolean).join('');

  const future = S.forecast.hourly.filter(f => Date.parse(f.datetime) > now - 30 * 60e3);
  const hours = [{ label: 'עכשיו', cond: e.state, t: a.temperature },
    ...[1, 3, 5, 7, 9].map(i => future[i]).filter(Boolean)
      .map(f => ({ label: hhmm(new Date(f.datetime)), cond: f.condition, t: f.temperature }))];

  const days = S.forecast.daily.slice(0, 4);
  const lo = Math.min(...days.map(d => d.templow ?? d.temperature));
  const hi = Math.max(...days.map(d => d.temperature));
  const span = Math.max(hi - lo, 1);
  const todayStr = new Date().toDateString();

  el.innerHTML = header('weather-partly-cloudy', 'מזג אוויר', src ? `<span class="meta">${esc(src)}</span>` : '') +
    `<div class="w-now">
      <span class="mdi mdi-${weatherIcon(e.state)}"></span>
      <div><div class="big num">${fmt(a.temperature, 0)}°</div>
        <div class="w-cond">${esc(T.cond[e.state] || e.state)}${today ? ` · <span class="num">${fmt(today.templow, 0)}° / ${fmt(today.temperature, 0)}°</span>` : ''}</div>
        <div class="w-extra">${extras}</div></div>
    </div>` +
    (hours.length > 1 ? `<div class="hours">${hours.map(h =>
      `<div class="h"><span>${esc(h.label)}</span><span class="mdi mdi-${weatherIcon(h.cond)}"></span><b class="num">${fmt(h.t, 0)}°</b></div>`).join('')}</div>` : '') +
    `<div class="days">${days.map(d => {
      const dt = new Date(d.datetime);
      const tl = d.templow ?? d.temperature;
      const rain = d.precipitation > 0 ? `<span class="num">${fmt(d.precipitation)}</span>מ״מ` : '';
      return `<div class="day"><span class="dn">${dt.toDateString() === todayStr ? 'היום' : T.days[dt.getDay()]}</span>
        <span class="mdi mdi-${weatherIcon(d.condition)}"></span><span class="rain">${rain}</span>
        <span class="lo num">${fmt(tl, 0)}°</span>
        <span class="bar"><i data-s="${((tl - lo) / span * 100).toFixed(1)}" data-w="${Math.max((d.temperature - tl) / span * 100, 4).toFixed(1)}"></i></span>
        <span class="hi num">${fmt(d.temperature, 0)}°</span></div>`;
    }).join('')}</div>`;
  applyStyles(el);
}

// ---------- car ----------
function minutesAgo(c) {
  let t = 0;
  const upd = E(c.updated);
  if (upd && !bad(upd) && Number.isFinite(Date.parse(upd.state))) t = Date.parse(upd.state);
  else for (const k of ['battery', 'range', 'plugged', 'state']) {
    const e = E(c[k]);
    if (e) t = Math.max(t, Date.parse(e.last_updated || e.last_changed) || 0);
  }
  return t ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
}

function renderCar() {
  const el = $('#p-car');
  const c = S.layout.car;
  if (!c) {
    el.innerHTML = header('car-electric', 'רכב') + hint('לא נמצאו חיישני TeslaMate. הגדירו <code>car.battery</code> בקובץ ההגדרות');
    return;
  }
  const bat = num(c.battery);
  const range = num(c.range);
  const plugged = E(c.plugged)?.state === 'on';
  const carState = E(c.state)?.state;
  const power = num(c.charger_power);
  const charging = carState === 'charging' || (c.charge_switch && E(c.charge_switch)?.state === 'on') || (power != null && power > 0.1);
  const big = charging ? `בטעינה${power ? ` · <span class="num">${fmt(power)} kW</span>` : ''}` : plugged ? 'מחובר לחשמל' : 'לא מחובר';
  const cable = c.plugged ? (plugged ? 'כבל מחובר' : 'כבל לא מחובר') : '';
  const line2 = [cable, carState && carState !== 'charging' ? (T.car[carState] || carState) : ''].filter(Boolean).join(' · ');
  const ago = minutesAgo(c);
  const agoText = ago == null ? '' : ago < 1 ? 'עודכן עכשיו' : ago < 60 ? `עודכן לפני ${ago} דק׳` : `עודכן לפני ${Math.round(ago / 60)} שע׳`;

  const R = 44, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, bat ?? 0));
  const ringColor = pct < 20 ? 'var(--red)' : charging ? 'var(--green)' : 'var(--blue)';

  // charge limit
  let limitRow = '';
  if (c.charge_limit) {
    const le = E(c.charge_limit);
    const ctl = ['number', 'input_number'].includes(domain(c.charge_limit)) && canControl(c.charge_limit) && !bad(le);
    const v = S.pendingLimit?.value ?? num(c.charge_limit);
    limitRow = `<div class="row"><div class="rl">הגבלת טעינה</div>
      <div class="stepper"><button data-act="limit" data-dir="1"${ctl ? '' : ' disabled'} aria-label="הגדלה"><span class="mdi mdi-plus"></span></button>
      <span class="sv num">${fmt(v, 0)}%</span>
      <button data-act="limit" data-dir="-1"${ctl ? '' : ' disabled'} aria-label="הקטנה"><span class="mdi mdi-minus"></span></button></div></div>`;
  }
  let lbRow = '';
  if (c.load_balancing || c.commands_today) {
    const lb = E(c.load_balancing);
    const cmds = num(c.commands_today);
    lbRow = `<div class="row">
      <div><div class="rl">${c.load_balancing ? 'איזון עומסים' : 'פקודות'}</div>
      ${cmds != null ? `<div class="rs"><span class="num">${fmt(cmds, 0)}${c.commands_limit ? '/' + c.commands_limit : ''}</span> פקודות היום</div>` : ''}</div>
      ${c.load_balancing ? `<button class="toggle${lb?.state === 'on' ? ' on' : ''}" data-act="toggle" data-id="${esc(c.load_balancing)}"${canControl(c.load_balancing) && !bad(lb) ? '' : ' disabled'} aria-label="איזון עומסים"></button>` : ''}
    </div>${cmds != null && c.commands_limit ? `<div class="meter"><i data-w="${Math.min(100, cmds / c.commands_limit * 100).toFixed(0)}"></i></div>` : ''}`;
  }
  const ctlId = c.charge_switch || c.charge_button;
  const btn = ctlId
    ? `<button class="bigbtn${charging ? ' stop' : ''}" data-act="charge"${canControl(ctlId) && (!c.plugged || plugged) ? '' : ' disabled'}>
        <span class="mdi mdi-${charging ? 'stop' : 'lightning-bolt'}"></span>${charging ? 'עצירת טעינה' : 'התחלת טעינה'}</button>`
    : '<div class="note">TeslaMate מספק נתונים בלבד. לשליטה בטעינה הגדירו <span class="num">car.charge_switch</span></div>';

  el.innerHTML = `
    <div class="car-top">
      <div class="ring"><svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="${R}" fill="none" stroke="var(--card-2)" stroke-width="8"/>
        <circle cx="50" cy="50" r="${R}" fill="none" stroke="${ringColor}" stroke-width="8" stroke-linecap="round"
          stroke-dasharray="${(C * pct / 100).toFixed(1)} ${C.toFixed(1)}"/></svg>
        <div class="rc"><b class="num">${bat == null ? '–' : Math.round(bat) + '%'}</b>${range != null ? `<span><span class="num">${Math.round(range)}</span> ק״מ</span>` : ''}</div>
      </div>
      <div class="txt"><div class="label">${esc(c.name)}</div><div class="state">${big}</div>
        ${line2 ? `<div class="cable"><span class="mdi mdi-power-plug${plugged ? '' : '-off'}-outline"></span>${esc(line2)}</div>` : ''}
        ${agoText ? `<span class="chip-upd"><span class="mdi mdi-refresh"></span>${agoText}</span>` : ''}</div>
    </div>
    <div class="car-body">${limitRow}${lbRow}${btn}</div>`;
  applyStyles(el);
}

function nudgeLimit(dir) {
  const id = S.layout.car?.charge_limit;
  const e = E(id);
  if (!e) return;
  const a = e.attributes;
  const step = Math.max(Number(a.step) || 1, 5);
  const min = a.min ?? 50, max = a.max ?? 100;
  const cur = S.pendingLimit?.value ?? num(id) ?? max;
  const next = Math.min(max, Math.max(min, Math.round((cur + dir * step) / step) * step));
  if (S.pendingLimit) clearTimeout(S.pendingLimit.timer);
  S.pendingLimit = {
    value: next,
    timer: setTimeout(() => { S.pendingLimit = null; call(domain(id), 'set_value', id, { value: next }); }, 800),
  };
  renderCar();
}

// ---------- home control ----------
const devId = d => (typeof d === 'string' ? d : d.entity);

function devIcon(id, on, custom) {
  if (custom) return custom;
  const e = E(id);
  if (e?.attributes.icon?.startsWith('mdi:')) return e.attributes.icon.slice(4);
  switch (domain(id)) {
    case 'light': return on ? 'lightbulb' : 'lightbulb-outline';
    case 'media_player': return 'television';
    case 'fan': return 'fan';
    case 'switch': return e?.attributes.device_class === 'outlet' ? 'power-socket-eu' : 'toggle-switch-outline';
    case 'cover': return 'window-shutter';
    default: return 'power';
  }
}

const isOn = e => !!e && !bad(e) && !['off', 'standby', 'idle', 'closed'].includes(e.state);

function renderControls() {
  const el = $('#p-controls');
  const { devices = [], actions = [] } = S.layout.controls || {};
  if (!devices.length && !actions.length) {
    el.innerHTML = header('home-outline', 'שליטה בבית') + hint('הוסיפו מכשירים ל-<code>controls.devices</code> בקובץ ההגדרות');
    return;
  }
  const tiles = devices.map(d => {
    const id = devId(d);
    const e = E(id);
    const on = isOn(e);
    const off = bad(e);
    const label = off ? 'לא זמין' : on ? (domain(id) === 'light' ? 'דלוק' : 'פועל') : 'כבוי';
    return `<button class="dev${on ? ' on' : ''}${off ? ' off-line' : ''}" data-act="device" data-id="${esc(id)}"${off || !canControl(id) ? ' disabled' : ''}>
      <span class="mdi mdi-${esc(devIcon(id, on, d.icon))}"></span>
      <span class="dn">${esc(nameOf(id, d.name))}</span><span class="ds">${label}</span></button>`;
  }).join('');
  const acts = actions.map((a, i) =>
    `<button class="act" data-act="action" data-i="${i}"><span class="mdi mdi-${esc(a.icon || 'play')}"></span>${esc(a.label || nameOf(a.entity))}</button>`).join('');
  el.innerHTML = header('home-outline', 'שליטה בבית') +
    `<div class="devices">${tiles}</div>${acts ? `<div class="actions">${acts}</div>` : ''}`;
}

function runAction(a) {
  if (a.type === 'all_lights_off') {
    const lights = (S.layout.controls.devices || []).map(devId).filter(id => domain(id) === 'light' && isOn(E(id)));
    lights.forEach(id => call('light', 'turn_off', id));
    toast(lights.length ? 'כל האורות כובו' : 'כל האורות כבר כבויים');
    return;
  }
  const id = a.entity;
  const d = domain(id);
  if (d === 'button') call(d, 'press', id);
  else if (d === 'script' || d === 'scene') call(d, 'turn_on', id);
  else call(d, 'toggle', id);
  toast(`${a.label || nameOf(id)} הופעל`);
}

// ---------- tasks ----------
function renderTasks() {
  const id = S.layout.todo?.entity;
  const input = $('#task-input');
  input.disabled = !canControl(id);
  input.placeholder = id ? 'משימה חדשה...' : 'לא נמצאה רשימת משימות';
  const open = S.todo.filter(t => t.status !== 'completed');
  const done = S.todo.filter(t => t.status === 'completed');
  $('#task-count').textContent = open.length;
  const li = t => `<li data-uid="${esc(t.uid)}" data-status="${esc(t.status)}" class="${t.status === 'completed' ? 'done' : ''}">
    <span class="mdi mdi-${t.status === 'completed' ? 'check-circle' : 'circle-outline'}"></span>${esc(t.summary)}</li>`;
  $('#task-list').innerHTML = open.length || done.length
    ? [...open, ...done].map(li).join('')
    : '<li class="empty">אין משימות פתוחות</li>';
}

$('#task-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const input = $('#task-input');
  const text = input.value.trim();
  const id = S.layout.todo?.entity;
  if (!text || !id) return;
  call('todo', 'add_item', id, { item: text });
  input.value = '';
});

let press = null;
const list = $('#task-list');
list.addEventListener('contextmenu', ev => ev.preventDefault());
list.addEventListener('pointerdown', ev => {
  const li = ev.target.closest('li[data-uid]');
  if (!li) return;
  li.classList.add('pressing');
  const p = { li, fired: false };
  p.timer = setTimeout(() => {
    p.fired = true;
    li.classList.remove('pressing');
    call('todo', 'remove_item', S.layout.todo?.entity, { item: li.dataset.uid });
    toast('המשימה נמחקה');
  }, 650);
  press = p;
});
function endPress() {
  const p = press;
  press = null;
  if (p) { clearTimeout(p.timer); p.li.classList.remove('pressing'); }
  return p;
}
list.addEventListener('pointerup', () => {
  const p = endPress();
  if (!p || p.fired) return;
  const status = p.li.dataset.status === 'completed' ? 'needs_action' : 'completed';
  call('todo', 'update_item', S.layout.todo?.entity, { item: p.li.dataset.uid, status });
});
list.addEventListener('pointercancel', endPress);
list.addEventListener('pointerleave', endPress);

// ---------- info ----------
function secondaryText(id) {
  const e = E(id);
  if (bad(e)) return '';
  const a = e.attributes;
  if (a.device_class === 'timestamp') {
    const m = Math.round((Date.parse(e.state) - Date.now()) / 60000);
    return Number.isFinite(m) ? `עוד ${Math.max(0, m)} דק׳` : '';
  }
  const n = parseFloat(e.state);
  if (Number.isFinite(n) && /^min/.test(a.unit_of_measurement || '')) return `עוד ${Math.round(n)} דק׳`;
  return Number.isFinite(n) ? `${fmt(n)}${a.unit_of_measurement ? ' ' + a.unit_of_measurement : ''}` : stateText(e.state);
}

function valueText(id) {
  const e = E(id);
  if (!e) return '–';
  if (bad(e)) return 'לא זמין';
  const n = parseFloat(e.state);
  const unit = e.attributes.unit_of_measurement;
  const u = { min: 'דק׳', h: 'שע׳', km: 'ק״מ', s: 'שנ׳' }[unit] || unit;
  if (Number.isFinite(n) && !/^\d{4}-/.test(e.state)) return `${fmt(n)}${u ? (u === '%' ? '%' : ' ' + u) : ''}`;
  return stateText(e.state);
}

function renderInfo() {
  const el = $('#p-info');
  const rows = S.layout.info || [];
  if (!rows.length) {
    el.innerHTML = header('information-outline', 'מידע') + hint('הוסיפו שורות ל-<code>info</code> בקובץ ההגדרות');
    return;
  }
  el.innerHTML = header('information-outline', 'מידע') + `<div class="info">${rows.map(r => {
    const e = E(r.entity);
    if (!e) return '';
    if (r.type === 'sun') {
      const rise = new Date(e.attributes.next_rising), set = new Date(e.attributes.next_setting);
      return `<div class="irow sunrow"><span class="mdi mdi-weather-sunset-up"></span>
        <div><div class="il">${esc(r.label || 'זריחה · שקיעה')}</div><div class="iv"><span class="num">${hhmm(rise)}</span> · <span class="num">${hhmm(set)}</span></div></div>
        <span class="mdi mdi-weather-sunset-down sunset"></span></div>`;
    }
    const sec = r.secondary ? secondaryText(r.secondary) : '';
    return `<div class="irow"><span class="mdi mdi-${esc(r.icon || e.attributes.icon?.replace('mdi:', '') || 'information-outline')}"></span>
      <div><div class="il">${esc(r.label || e.attributes.friendly_name || r.entity)}</div>
      <div class="iv">${esc(valueText(r.entity))}${sec ? ' · ' + esc(sec) : ''}</div></div></div>`;
  }).join('')}</div>`;
}

// ---------- clicks ----------
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled) return;
  switch (b.dataset.act) {
    case 'device': {
      const id = b.dataset.id;
      const d = domain(id);
      if (d === 'cover') call(d, E(id)?.state === 'open' ? 'close_cover' : 'open_cover', id);
      else call(d, 'toggle', id);
      break;
    }
    case 'action': runAction(S.layout.controls.actions[Number(b.dataset.i)]); break;
    case 'toggle': call(domain(b.dataset.id), 'toggle', b.dataset.id); break;
    case 'limit': nudgeLimit(Number(b.dataset.dir)); break;
    case 'charge': {
      const c = S.layout.car;
      if (c.charge_switch) {
        const on = E(c.charge_switch)?.state === 'on';
        call(domain(c.charge_switch), on ? 'turn_off' : 'turn_on', c.charge_switch);
      } else if (c.charge_button) {
        call('button', 'press', c.charge_button);
      }
      break;
    }
  }
});

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
setInterval(tickClock, 10000);
setInterval(() => { if (S.layout.car) renderCar(); }, 60000);
renderStatus();
connect();
