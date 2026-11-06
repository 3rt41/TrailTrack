/* TrailTrack — tracker per allenamenti e trekking.
 * Tutto gira nel browser: GPS (Geolocation API), battito (Web Bluetooth,
 * Heart Rate Service standard), storage (IndexedDB), mappe (Leaflet + OSM).
 */

// ───────────────────────── Costanti ─────────────────────────
const TYPES = {
  hike:    { label: 'Trekking',    icon: '🥾', gps: true,  pauseWindow: 30, maxSpeed: 6,  met: 6.0,  q: 2,  speedUnit: 'pace' },
  walk:    { label: 'Camminata',   icon: '🚶', gps: true,  pauseWindow: 25, maxSpeed: 6,  met: 3.8,  q: 2,  speedUnit: 'pace' },
  run:     { label: 'Corsa',       icon: '🏃', gps: true,  pauseWindow: 12, maxSpeed: 10, met: 9.8,  q: 4,  speedUnit: 'pace' },
  bike:    { label: 'Bici',        icon: '🚴', gps: true,  pauseWindow: 10, maxSpeed: 30, met: 7.5,  q: 8,  speedUnit: 'speed' },
  workout: { label: 'Allenamento', icon: '🏋️', gps: false, pauseWindow: 0,  maxSpeed: 0,  met: 5.0,  q: 1,  speedUnit: 'none' },
};
const ZONES = [
  { name: 'Z1', label: 'Recupero',   from: 0.50, color: '#7fa7c9' },
  { name: 'Z2', label: 'Aerobico',   from: 0.60, color: '#5bd18b' },
  { name: 'Z3', label: 'Tempo',      from: 0.70, color: '#e6d14b' },
  { name: 'Z4', label: 'Soglia',     from: 0.80, color: '#f29b4b' },
  { name: 'Z5', label: 'Massimale',  from: 0.90, color: '#ef5b6b' },
];
const DEFAULT_SETTINGS = {
  weight: 70, age: 35, sex: 'm', maxHr: null,
  autoPause: true, wake: true, vibrate: true, maxAcc: 35, demo: false,
  lastType: 'hike',
};

// ───────────────────────── Utility ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function haversine(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}
function fmtDurShort(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const fmtKm = (m, d = 2) => (m / 1000).toFixed(d);
function fmtPace(mps) {
  if (!mps || mps < 0.15) return '--';
  const spk = 1000 / mps; const m = Math.floor(spk / 60), s = Math.round(spk % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}
const fmtSpeed = (mps) => (mps ? (mps * 3.6).toFixed(1) : '--');
function speedHtml(type, mps) {
  return TYPES[type].speedUnit === 'speed' ? `${fmtSpeed(mps)}<small> km/h</small>` : `${fmtPace(mps)}<small> /km</small>`;
}
const fmtDate = (t) => new Date(t).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

function toast(msg, ms = 2600) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms);
}
function dialog(text, buttons) {
  return new Promise((res) => {
    $('#modalText').textContent = text;
    const box = $('#modalBtns'); box.innerHTML = '';
    buttons.forEach((b) => {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || 'btn-ghost'); el.textContent = b.label;
      el.onclick = () => { $('#modal').classList.add('hidden'); res(b.value); };
      box.appendChild(el);
    });
    $('#modal').classList.remove('hidden');
  });
}
const confirmDlg = (t, ok = 'Conferma', cls = 'btn-danger') =>
  dialog(t, [{ label: 'Annulla', value: false }, { label: ok, value: true, cls }]);
function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function vibrate(p) { if (settings.vibrate && navigator.vibrate) navigator.vibrate(p); }

// ───────────────────────── Storage (IndexedDB) ─────────────────────────
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('trailtrack', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('activities', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  return {
    put: (a) => tx('activities', 'readwrite', (s) => s.put(a)),
    get: (id) => tx('activities', 'readonly', (s) => s.get(id)),
    all: () => tx('activities', 'readonly', (s) => s.getAll()),
    del: (id) => tx('activities', 'readwrite', (s) => s.delete(id)),
    kvGet: (k) => tx('kv', 'readonly', (s) => s.get(k)),
    kvSet: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
    kvDel: (k) => tx('kv', 'readwrite', (s) => s.delete(k)),
  };
})();

let settings = { ...DEFAULT_SETTINGS };
const maxHr = () => settings.maxHr || Math.round(208 - 0.7 * settings.age); // formula di Tanaka
function zoneOf(bpm) {
  const r = bpm / maxHr(); let z = -1;
  ZONES.forEach((zz, i) => { if (r >= zz.from) z = i; });
  return z;
}

// ───────────────────────── Filtro di Kalman sulla posizione ─────────────────────────
/* Il GPS "balla" di qualche metro anche da fermo: senza filtro la distanza si gonfia.
 * Filtro di Kalman a posizione costante: q = velocità tipica dell'attività (m/s). */
class Kalman {
  constructor(q) { this.q = q; this.v = -1; }
  reset() { this.v = -1; }
  process(lat, lon, acc, t) {
    acc = Math.max(1, acc);
    if (this.v < 0) { Object.assign(this, { t, lat, lon, v: acc * acc }); }
    else {
      const dt = t - this.t;
      if (dt > 0) { this.v += (dt * this.q * this.q) / 1000; this.t = t; }
      const k = this.v / (this.v + acc * acc);
      this.lat += k * (lat - this.lat); this.lon += k * (lon - this.lon);
      this.v = (1 - k) * this.v;
    }
    return { lat: this.lat, lon: this.lon };
  }
}

// ───────────────────────── Dislivello ─────────────────────────
/* L'altitudine GPS oscilla di parecchi metri: sommare ogni variazione gonfierebbe
 * il dislivello. Si smussa con una media mobile esponenziale e si conta una salita/
 * discesa solo quando supera una soglia (isteresi). */
class Elevation {
  constructor(threshold = 4, alpha = 0.3) { Object.assign(this, { threshold, alpha, gain: 0, loss: 0, ref: null, s: null, min: Infinity, max: -Infinity }); }
  add(alt) {
    if (alt == null || !Number.isFinite(alt)) return this.s;
    this.s = this.s == null ? alt : this.s + this.alpha * (alt - this.s);
    if (this.ref == null) this.ref = this.s;
    const d = this.s - this.ref;
    if (d >= this.threshold) { this.gain += d; this.ref = this.s; }
    else if (d <= -this.threshold) { this.loss -= d; this.ref = this.s; }
    this.min = Math.min(this.min, this.s); this.max = Math.max(this.max, this.s);
    return this.s;
  }
}
const altOf = (act, p) => (act.demApplied && p.dem != null ? p.dem : p.alt);

// ───────────────────────── Statistiche ─────────────────────────
function computeStats(act) {
  const pts = act.points, n = pts.length;
  const cum = new Float64Array(n), alts = new Array(n);
  const el = act.demApplied ? new Elevation(1.5, 0.6) : new Elevation(4, 0.3);
  let dist = 0, maxSpeed = 0, j = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && pts[i].seg === pts[i - 1].seg) dist += haversine(pts[i - 1], pts[i]);
    cum[i] = dist;
    alts[i] = el.add(altOf(act, pts[i]));
    // velocità massima su finestre di almeno 10 s di movimento (evita picchi da rumore GPS)
    while (j < i && (pts[i].mt - pts[j + 1].mt >= 10000 || pts[j].seg !== pts[i].seg)) j++;
    const dmt = pts[i].mt - pts[j].mt;
    if (pts[j].seg === pts[i].seg && dmt >= 10000) maxSpeed = Math.max(maxSpeed, (cum[i] - cum[j]) / (dmt / 1000));
  }
  const moving = act.movingMs, total = act.totalMs;
  const avgSpeed = moving > 0 ? dist / (moving / 1000) : 0;

  // battito
  let hrAvg = null, hrMax = null; const zoneMs = ZONES.map(() => 0);
  if (act.hr?.length) {
    let sum = 0, w = 0;
    for (let i = 0; i < act.hr.length; i++) {
      const h = act.hr[i];
      const dt = i + 1 < act.hr.length ? Math.min(5000, act.hr[i + 1].t - h.t) : 1000;
      sum += h.bpm * dt; w += dt; hrMax = Math.max(hrMax || 0, h.bpm);
      const z = zoneOf(h.bpm); if (z >= 0) zoneMs[z] += dt;
    }
    hrAvg = w ? Math.round(sum / w) : null;
  }
  let rmssd = null;
  if (act.rr?.length > 20) rmssd = calcRmssd(act.rr);

  // calorie: formula di Keytel con il battito, altrimenti MET + lavoro in salita
  const W = settings.weight, A = settings.age, min = moving / 60000;
  let kcal;
  if (hrAvg) {
    kcal = settings.sex === 'f'
      ? ((-20.4022 + 0.4472 * hrAvg - 0.1263 * W + 0.074 * A) / 4.184) * min
      : ((-55.0969 + 0.6309 * hrAvg + 0.1988 * W + 0.2017 * A) / 4.184) * min;
  } else {
    kcal = TYPES[act.type].met * W * (moving / 3600000);
    if (act.type !== 'bike') kcal += W * 9.81 * el.gain / 0.25 / 4184;
  }

  // parziali per km
  const splits = []; let kmIdx = 1, prev = { mt: 0, d: 0, alt: alts.find((a) => a != null) ?? null, hrSum: 0, hrN: 0, i: 0 };
  for (let i = 1; i < n; i++) {
    while (cum[i] >= kmIdx * 1000) {
      const f = (kmIdx * 1000 - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      const mt = pts[i - 1].mt + f * (pts[i].mt - pts[i - 1].mt);
      const alt = alts[i];
      const hrs = pts.slice(prev.i, i + 1).map((p) => p.hr).filter(Boolean);
      splits.push({ km: kmIdx, ms: mt - prev.mt, dist: 1000, dAlt: alt != null && prev.alt != null ? alt - prev.alt : null, hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b) / hrs.length) : null });
      prev = { mt, alt, i };
      kmIdx++;
    }
  }
  if (n > 1 && dist - (kmIdx - 1) * 1000 > 50) {
    const alt = alts[n - 1]; const hrs = pts.slice(prev.i).map((p) => p.hr).filter(Boolean);
    splits.push({ km: +(dist / 1000).toFixed(2), ms: pts[n - 1].mt - prev.mt, dist: dist - (kmIdx - 1) * 1000, dAlt: alt != null && prev.alt != null ? alt - prev.alt : null, hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b) / hrs.length) : null, partial: true });
  }

  return {
    distance: dist, movingMs: moving, totalMs: total, pausedMs: Math.max(0, total - moving),
    avgSpeed, maxSpeed, gain: el.gain, loss: el.loss,
    altMin: Number.isFinite(el.min) ? el.min : null, altMax: Number.isFinite(el.max) ? el.max : null,
    altLast: el.s, hrAvg, hrMax, zoneMs, rmssd, kcal: Math.max(0, Math.round(kcal)),
    splits, cum, alts, autoPauses: act.pauses.filter((p) => p.auto).length,
  };
}
function calcRmssd(rr) {
  const v = rr.filter((x) => x > 300 && x < 2000); // scarta artefatti
  if (v.length < 10) return null;
  let s = 0, k = 0;
  for (let i = 1; i < v.length; i++) { const d = v[i] - v[i - 1]; if (Math.abs(d) < 250) { s += d * d; k++; } }
  return k ? Math.round(Math.sqrt(s / k)) : null;
}
const statsSummary = (st) => {
  const { cum, alts, ...rest } = st; return rest;
};

// ───────────────────────── Sorgenti di posizione ─────────────────────────
const RealGeo = {
  id: null,
  start(onFix, onErr) {
    if (!('geolocation' in navigator)) { onErr({ message: 'Geolocalizzazione non supportata' }); return; }
    this.id = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  },
  stop() { if (this.id != null) navigator.geolocation.clearWatch(this.id); this.id = null; },
};
/* Simulatore: un giro in salita con soste, rumore GPS realistico. */
const SimGeo = {
  timer: null, lat: 46.4102, lon: 11.8440, alt: 1450, heading: 40, t: 0,
  start(onFix) {
    this.t = 0;
    this.timer = setInterval(() => {
      this.t++;
      const cycle = this.t % 240; const stopped = cycle > 180 && cycle < 225; // sosta di 45 s ogni 4 min
      const speed = stopped ? 0 : 1.15 + 0.25 * Math.sin(this.t / 37);
      this.heading += (Math.random() - 0.5) * 12 + Math.sin(this.t / 90) * 2;
      const rad = this.heading * Math.PI / 180;
      this.lat += (speed * Math.cos(rad)) / 111320;
      this.lon += (speed * Math.sin(rad)) / (111320 * Math.cos(this.lat * Math.PI / 180));
      if (!stopped) this.alt += speed * (0.09 * Math.sin(this.t / 400) + 0.04);
      // errore GPS realistico: deriva lenta (correlata) + piccolo rumore bianco
      const n = () => (Math.random() + Math.random() + Math.random() - 1.5);
      const acc = 4 + Math.random() * 5;
      this.bx = clamp((this.bx || 0) * 0.97 + n() * 0.8, -8, 8); this.by = clamp((this.by || 0) * 0.97 + n() * 0.8, -8, 8);
      this.bz = clamp((this.bz || 0) * 0.98 + n() * 0.9, -12, 12);
      onFix({ coords: { latitude: this.lat + (this.by + n() * 1.5) / 111320, longitude: this.lon + (this.bx + n() * 1.5) / 77000, altitude: this.alt + this.bz + n() * 1.5, accuracy: acc, speed: stopped ? Math.random() * 0.2 : speed + n() * 0.1 }, timestamp: Date.now() });
    }, 1000);
  },
  stop() { clearInterval(this.timer); this.timer = null; },
};

// ───────────────────────── Battito: Web Bluetooth ─────────────────────────
const HR = {
  device: null, char: null, bpm: null, lastAt: 0, battery: null, rr: [], listeners: new Set(), sim: null, tries: 0,
  get supported() { return !!navigator.bluetooth; },
  get connected() { return !!this.sim || !!this.device?.gatt?.connected; },
  get name() { return this.sim ? 'Band demo (simulata)' : this.device?.name || 'Sensore'; },
  on(fn) { this.listeners.add(fn); },
  emit() { this.listeners.forEach((f) => f(this)); },
  async connect() {
    if (settings.demo) { this.startSim(); return; }
    if (!this.supported) throw new Error('Web Bluetooth non disponibile in questo browser');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['battery_service', 'device_information'],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect());
    this.tries = 0;
    await this.setup();
  },
  async setup() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService('heart_rate');
    this.char = await svc.getCharacteristic('heart_rate_measurement');
    this.char.addEventListener('characteristicvaluechanged', (e) => this.parse(e.target.value));
    await this.char.startNotifications();
    try {
      const b = await (await server.getPrimaryService('battery_service')).getCharacteristic('battery_level');
      this.battery = (await b.readValue()).getUint8(0);
      b.addEventListener('characteristicvaluechanged', (e) => { this.battery = e.target.value.getUint8(0); this.emit(); });
      await b.startNotifications().catch(() => {});
    } catch { /* batteria opzionale */ }
    this.emit();
  },
  parse(dv) {
    const flags = dv.getUint8(0); let i = 1, bpm;
    if (flags & 1) { bpm = dv.getUint16(i, true); i += 2; } else { bpm = dv.getUint8(i); i += 1; }
    const contact = (flags >> 1) & 3; // 2 = sensore non a contatto con la pelle
    if (flags & 8) i += 2; // energia spesa
    const rr = [];
    if (flags & 16) for (; i + 1 < dv.byteLength; i += 2) rr.push((dv.getUint16(i, true) / 1024) * 1000);
    this.push(bpm, rr, contact !== 2);
  },
  push(bpm, rr = [], contact = true) {
    if (!contact || !bpm) return;
    this.bpm = bpm; this.lastAt = Date.now();
    this.rr.push(...rr); if (this.rr.length > 600) this.rr.splice(0, this.rr.length - 600);
    this.emit();
    Recorder.onHr(bpm, rr);
  },
  async onDisconnect() {
    this.emit();
    if (!this.device || this.tries >= 6) return;
    this.tries++;
    toast('Band disconnessa, riconnessione…');
    await new Promise((r) => setTimeout(r, 1500 * this.tries));
    try { await this.setup(); this.tries = 0; toast('Band riconnessa'); } catch { this.onDisconnect(); }
  },
  disconnect() {
    if (this.sim) { clearInterval(this.sim); this.sim = null; }
    const d = this.device; this.device = null; this.bpm = null;
    d?.gatt?.connected && d.gatt.disconnect();
    this.emit();
  },
  startSim() {
    let base = 72, t = 0; this.battery = 84;
    this.sim = setInterval(() => {
      t++;
      const target = Recorder.state?.status === 'recording' && !Recorder.state.autoPaused ? 128 + 18 * Math.sin(t / 60) : 82;
      base += (target - base) * 0.05 + (Math.random() - 0.5) * 2;
      const bpm = Math.round(base);
      const rrBase = 60000 / bpm; const rr = [rrBase + (Math.random() - 0.5) * 60];
      this.push(bpm, rr);
    }, 1000);
    this.emit();
  },
  get fresh() { return this.bpm && Date.now() - this.lastAt < 6000 ? this.bpm : null; },
};

// ───────────────────────── Wake Lock ─────────────────────────
const Wake = {
  lock: null,
  async on() { if (!settings.wake || !('wakeLock' in navigator)) return; try { this.lock = await navigator.wakeLock.request('screen'); } catch { /* ignorato */ } },
  off() { this.lock?.release?.(); this.lock = null; },
};

// ───────────────────────── Registratore ─────────────────────────
/* Due tempi:
 *  - totalMs: tempo dall'avvio allo stop, esclusa solo la pausa MANUALE;
 *  - movingMs: come sopra ma escluse anche le pause AUTOMATICHE (sosta rilevata).
 * Rilevamento sosta: se negli ultimi N secondi tutte le posizioni stanno in un
 * cerchio poco più grande della precisione GPS, sei fermo. La pausa viene
 * retrodatata all'inizio della finestra, così il tempo in movimento è esatto. */
const Recorder = {
  state: null, timer: null, lastSave: 0, lastRender: 0,
  get type() { return TYPES[this.state.act.type]; },

  start(type) {
    const now = Date.now();
    const act = {
      id: uid(), type, name: defaultName(type, now), startTime: now, endTime: null,
      points: [], hr: [], rr: [], pauses: [], movingMs: 0, totalMs: 0, seg: 0, demApplied: false, source: settings.demo ? 'demo' : 'gps',
    };
    this.state = { act, status: 'recording', autoPaused: false, lastTick: now, buf: [], lastFixAt: now, resumeHits: 0, pauseCenter: null };
    this.begin();
    vibrate(80);
  },
  begin() {
    this.kf = null;
    if (this.type.gps) (settings.demo ? SimGeo : RealGeo).start((p) => this.onFix(p), (e) => this.onGeoErr(e));
    clearInterval(this.timer); this.timer = setInterval(() => this.tick(), 1000);
    Wake.on(); UI.recordMode(true); this.save(true); this.tick();
  },
  async restore(saved) {
    this.state = { ...saved, buf: [], resumeHits: 0, lastFixAt: Date.now() };
    this.begin();
  },
  onGeoErr(e) {
    const msg = e.code === 1 ? 'Permesso posizione negato: abilitalo nelle impostazioni del browser.' : `GPS: ${e.message || 'errore'}`;
    toast(msg, 4000); UI.gps(null);
  },
  onFix(pos) {
    const s = this.state; if (!s) return;
    const c = pos.coords, now = Date.now();
    s.lastFixAt = now; UI.gps(c.accuracy); UI.liveMe(c.latitude, c.longitude, c.accuracy);
    if (s.status !== 'recording' || c.accuracy > settings.maxAcc) return;
    let fix = { t: now, lat: +c.latitude.toFixed(6), lon: +c.longitude.toFixed(6), alt: c.altitude == null ? null : +c.altitude.toFixed(1), acc: Math.round(c.accuracy), spd: c.speed };

    // buffer delle ultime posizioni per il rilevamento della sosta
    s.buf.push(fix);
    const win = this.type.pauseWindow * 1000;
    while (s.buf.length && s.buf[0].t < now - win - 5000) s.buf.shift();

    const act = s.act, last = act.points[act.points.length - 1];
    const k = (this.kf ||= new Kalman(this.type.q)).process(fix.lat, fix.lon, fix.acc, now);
    const raw = fix;
    fix = { ...fix, lat: +k.lat.toFixed(6), lon: +k.lon.toFixed(6) };
    if (last && last.seg === act.seg) {
      const d = haversine(last, fix), dt = (now - last.t) / 1000;
      if (dt > 0 && d / dt > this.type.maxSpeed && d > 2 * fix.acc + 10 && dt < 60) return; // salto anomalo
    }

    if (s.autoPaused) {
      // ripartenza: due posizioni consecutive fuori dal cerchio di sosta, o velocità chiara
      const r = Math.max(12, fix.acc * 1.2);
      const away = s.pauseCenter && haversine(s.pauseCenter, raw) > r;
      const fast = fix.spd != null && fix.spd > 1.0 && fix.acc <= 15;
      s.resumeHits = away || fast ? s.resumeHits + 1 : 0;
      if (s.resumeHits >= 2) {
        // la ripartenza è avvenuta qualche secondo prima di quando la confermiamo: la retrodatiamo
        const spd = fix.spd != null && fix.spd > 0.4 ? fix.spd : 1.1;
        this.exitAutoPause(now, clamp(haversine(s.pauseCenter, raw) / spd * 1000, 0, 20000));
      } else return;
    } else if (settings.autoPause && this.isStationary(now)) {
      this.enterAutoPause(now - win);
      return;
    }

    // aggiunge il punto solo se lo spostamento supera il rumore GPS
    if (!last || last.seg !== act.seg || haversine(last, fix) >= Math.max(3, fix.acc * 0.5)) {
      this.addPoint(fix);
    }
  },
  isStationary(now) {
    const s = this.state, win = this.type.pauseWindow * 1000;
    const pts = s.buf.filter((p) => p.t >= now - win);
    if (!pts.length || pts[0].t > now - win + 3000) return false; // finestra non ancora coperta
    if (pts.length < 3) return false;
    const c = { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length };
    const acc = pts.map((p) => p.acc).sort((a, b) => a - b)[pts.length >> 1];
    const r = Math.max(8, acc * 1.1);
    if (pts.every((p) => haversine(c, p) <= r)) { s.pauseCenter = c; return true; }
    return false;
  },
  addPoint(fix) {
    const s = this.state, act = s.act;
    const p = { t: fix.t, lat: fix.lat, lon: fix.lon, alt: fix.alt, acc: fix.acc, mt: Math.round(act.movingMs), seg: act.seg };
    const hr = HR.fresh; if (hr) p.hr = hr;
    act.points.push(p);
    UI.liveTrackAdd(p);
    this.save();
  },
  enterAutoPause(since) {
    const s = this.state, act = s.act; if (s.autoPaused) return;
    const now = Date.now();
    since = Math.max(since, act.pauses.length ? (act.pauses[act.pauses.length - 1].end || since) : since, act.startTime);
    s.autoPaused = true; s.resumeHits = 0;
    act.movingMs = Math.max(0, act.movingMs - (now - since));
    // rimuove i punti "di rumore" registrati da fermo
    while (act.points.length > 1 && act.points[act.points.length - 1].t > since && act.points[act.points.length - 1].seg === act.seg) act.points.pop();
    act.pauses.push({ start: since, end: null, auto: true, lat: s.pauseCenter?.lat, lon: s.pauseCenter?.lon });
    UI.liveTrackRedraw();
    vibrate([60, 80, 60]); toast('⏸ Sosta rilevata: tempo in movimento fermo');
    this.save(true); this.render(true);
  },
  exitAutoPause(now, retro = 0) {
    const s = this.state; if (!s.autoPaused) return;
    s.autoPaused = false; s.resumeHits = 0; s.buf = [];
    const p = s.act.pauses[s.act.pauses.length - 1];
    if (p && !p.end) { retro = Math.min(retro, Math.max(0, now - p.start)); p.end = now - retro; s.act.movingMs += retro; }
    vibrate(120); toast('▶ Ripartito');
    this.save(true); this.render(true);
  },
  tick() {
    const s = this.state; if (!s) return;
    const now = Date.now(), dt = now - s.lastTick; s.lastTick = now;
    if (s.status === 'recording') {
      s.act.totalMs += dt;
      if (!s.autoPaused) s.act.movingMs += dt;
      // alcuni telefoni smettono di inviare posizioni quando sei fermo: lo consideriamo una sosta
      if (this.type.gps && settings.autoPause && !s.autoPaused && s.act.points.length &&
          now - s.lastFixAt > this.type.pauseWindow * 1500) {
        s.pauseCenter = s.act.points[s.act.points.length - 1];
        this.enterAutoPause(s.lastFixAt);
      }
    }
    this.render();
    if (now - this.lastSave > 10000) this.save(true);
  },
  onHr(bpm, rr) {
    const s = this.state; if (!s || s.status !== 'recording') return;
    const h = s.act.hr, last = h[h.length - 1];
    if (!last || Date.now() - last.t >= 1000) h.push({ t: Date.now(), bpm });
    if (rr?.length && !s.autoPaused) s.act.rr.push(...rr.map((x) => Math.round(x)));
  },
  togglePause() {
    const s = this.state, now = Date.now();
    if (s.status === 'recording') {
      if (s.autoPaused) { const p = s.act.pauses[s.act.pauses.length - 1]; if (p && !p.end) p.end = now; s.autoPaused = false; }
      s.status = 'paused'; s.act.pauses.push({ start: now, end: null, auto: false });
      toast('In pausa: il tempo è fermo');
    } else {
      s.status = 'recording'; s.lastTick = now; s.buf = [];
      const p = s.act.pauses[s.act.pauses.length - 1]; if (p && !p.end) p.end = now;
      this.kf = null;
      s.act.seg++; // nuovo segmento: lo spostamento durante la pausa non conta
      toast('Ripreso');
    }
    vibrate(60); this.save(true); this.render(true);
  },
  async stop() {
    const s = this.state; if (!s) return;
    this.tick();
    const act = s.act, now = Date.now();
    act.pauses.forEach((p) => { if (!p.end) p.end = now; });
    act.endTime = now;
    this.teardown();
    if (act.totalMs < 5000 && act.points.length < 2) { toast('Attività troppo breve, non salvata'); return; }
    act.stats = statsSummary(computeStats(act));
    await DB.put(act);
    toast('Attività salvata ✓');
    await History.load();
    Detail.open(act.id);
  },
  async discard() { this.teardown(); toast('Attività scartata'); },
  teardown() {
    RealGeo.stop(); SimGeo.stop(); clearInterval(this.timer); this.timer = null;
    this.state = null; Wake.off(); DB.kvDel('current'); UI.recordMode(false);
  },
  save(force) {
    const now = Date.now(); if (!force && now - this.lastSave < 5000) return;
    this.lastSave = now;
    const { buf, ...rest } = this.state;
    DB.kvSet('current', rest).catch(() => {});
  },
  render(force) {
    const s = this.state; if (!s) return;
    const now = Date.now(); if (!force && now - this.lastRender < 900) return;
    this.lastRender = now;
    UI.renderLive(s, computeStats(s.act));
  },
};

function defaultName(type, t) {
  const h = new Date(t).getHours();
  const part = h < 12 ? 'mattutin' : h < 18 ? 'pomeridian' : 'serale';
  const f = { hike: 'o', walk: 'a', run: 'a', bike: 'o', workout: 'o' }[type];
  const name = { hike: 'Trekking', walk: 'Camminata', run: 'Corsa', bike: 'Giro in bici', workout: 'Allenamento' }[type];
  return `${name} ${part === 'serale' ? 'serale' : part + f}`;
}

// ───────────────────────── Mappe ─────────────────────────
function baseLayers() {
  return {
    'Topografica': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' }),
    'Stradale': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }),
  };
}
function makeMap(el, layerKey = 'mapLayer') {
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([45.8, 10.5], 6);
  const layers = baseLayers();
  let saved = 'Topografica'; try { saved = localStorage.getItem(layerKey) || saved; } catch { /* */ }
  (layers[saved] || layers['Topografica']).addTo(map);
  L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => { try { localStorage.setItem(layerKey, e.name); } catch { /* */ } });
  L.control.zoom({ position: 'topleft' }).addTo(map);
  return map;
}
function rampColor(t) { // blu → verde → giallo → rosso
  t = clamp(t, 0, 1);
  const stops = [[63, 140, 255], [91, 209, 139], [242, 210, 75], [239, 91, 91]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c})`;
}

// ───────────────────────── UI live ─────────────────────────
const UI = {
  map: null, track: null, me: null, accCircle: null, follow: true, selectedType: 'hike',
  init() {
    this.map = makeMap('liveMap');
    this.track = L.polyline([], { color: '#5bd18b', weight: 5, opacity: 0.9 }).addTo(this.map);
    this.map.on('dragstart', () => { this.follow = false; $('#followBtn').classList.remove('active'); });
    $('#followBtn').onclick = () => {
      this.follow = true; $('#followBtn').classList.add('active');
      if (this.me) this.map.setView(this.me.getLatLng(), Math.max(this.map.getZoom(), 16));
      else this.locateOnce();
    };
    const tp = $('#typePicker');
    Object.entries(TYPES).forEach(([k, t]) => {
      const b = document.createElement('button'); b.dataset.type = k;
      b.innerHTML = `<span>${t.icon}</span>${t.label}`;
      b.onclick = () => this.pickType(k); tp.appendChild(b);
    });
    this.pickType(settings.lastType);
    $('#startBtn').onclick = () => this.start();
    $('#pauseBtn').onclick = () => Recorder.togglePause();
    $('#stopBtn').onclick = async () => {
      const r = await dialog('Terminare l\'attività?', [
        { label: 'Continua', value: 'no' }, { label: 'Scarta', value: 'discard', cls: 'btn-danger-ghost' }, { label: 'Salva', value: 'save', cls: 'btn-primary' }]);
      if (r === 'save') Recorder.stop();
      else if (r === 'discard' && await confirmDlg('Scartare definitivamente questa attività?', 'Scarta')) Recorder.discard();
    };
    this.locateOnce();
  },
  locateOnce() {
    if (settings.demo) { this.map.setView([SimGeo.lat, SimGeo.lon], 15); return; }
    navigator.geolocation?.getCurrentPosition((p) => {
      this.gps(p.coords.accuracy); this.liveMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
      this.map.setView([p.coords.latitude, p.coords.longitude], 15);
    }, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  },
  pickType(k) {
    this.selectedType = k;
    $$('#typePicker button').forEach((b) => b.classList.toggle('active', b.dataset.type === k));
    $('#startHint').textContent = TYPES[k].gps
      ? 'Il GPS viene attivato all\'avvio. Tieni l\'app aperta: lo schermo resta acceso automaticamente.'
      : 'Allenamento al chiuso: niente GPS, registra tempo, battito e calorie.';
  },
  async start() {
    settings.lastType = this.selectedType; saveSettings();
    if (TYPES[this.selectedType].gps && !settings.demo && !('geolocation' in navigator)) { toast('Questo dispositivo non ha la geolocalizzazione'); return; }
    this.track.setLatLngs([]);
    Recorder.start(this.selectedType);
    if (!HR.connected && settings.demo) HR.connect();
  },
  recordMode(on) {
    $('#preStart').classList.toggle('hidden', on);
    $('#liveStats').classList.toggle('hidden', !on);
    $('#statusPill').classList.toggle('hidden', !on);
    $('.tabbar [data-view=record]').classList.toggle('recording', on);
    if (!on) { this.track.setLatLngs([]); this.gps(null); }
    setTimeout(() => this.map.invalidateSize(), 50);
  },
  gps(acc) {
    const b = $('#gpsBadge');
    b.className = 'badge ' + (acc == null ? 'gps-off' : acc <= 10 ? 'gps-good' : acc <= settings.maxAcc ? 'gps-mid' : 'gps-bad');
    b.textContent = acc == null ? 'GPS --' : `GPS ±${Math.round(acc)} m`;
  },
  liveMe(lat, lon, acc) {
    const ll = [lat, lon];
    if (!this.me) {
      this.me = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(this.map);
      this.accCircle = L.circle(ll, { radius: acc, color: '#3fa9ff', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(this.map);
    } else { this.me.setLatLng(ll); this.accCircle.setLatLng(ll).setRadius(acc); }
    if (this.follow && Recorder.state) this.map.setView(ll, Math.max(this.map.getZoom(), 16), { animate: false });
  },
  liveTrackAdd(p) {
    const s = Recorder.state; const pts = s.act.points;
    if (pts.length > 1 && pts[pts.length - 2].seg !== p.seg) this.liveTrackRedraw();
    else this.track.addLatLng([p.lat, p.lon]);
  },
  liveTrackRedraw() {
    const pts = Recorder.state?.act.points || [];
    const segs = []; let cur = [];
    pts.forEach((p, i) => { if (i && p.seg !== pts[i - 1].seg) { segs.push(cur); cur = []; } cur.push([p.lat, p.lon]); });
    if (cur.length) segs.push(cur);
    this.track.setLatLngs(segs);
  },
  renderLive(s, st) {
    const act = s.act;
    $('#sTotal').textContent = fmtDur(act.totalMs);
    $('#sMoving').textContent = fmtDur(act.movingMs);
    $('#sDist').innerHTML = `${fmtKm(st.distance)}<small> km</small>`;
    const t = TYPES[act.type];
    $('#sSpeedLbl').textContent = t.speedUnit === 'speed' ? 'Velocità media' : 'Passo medio';
    $('#sSpeed').innerHTML = t.speedUnit === 'none' ? '--' : speedHtml(act.type, st.avgSpeed);
    $('#sGain').innerHTML = `${Math.round(st.gain)}<small> m</small>`;
    $('#sLoss').innerHTML = `${Math.round(st.loss)}<small> m</small>`;
    $('#sAlt').innerHTML = st.altLast != null ? `${Math.round(st.altLast)}<small> m</small>` : '--';
    const hr = HR.fresh;
    $('#sHr').innerHTML = hr ? `${hr}<small> bpm</small>` : (st.hrAvg ? `<small>media</small> ${st.hrAvg}` : '--');
    const pill = $('#statusPill'), pb = $('#pauseBtn');
    if (s.status === 'paused') { pill.className = 'status-pill manual'; pill.textContent = '❚❚ In pausa'; pb.textContent = '▶ Riprendi'; pb.className = 'btn btn-primary'; }
    else if (s.autoPaused) { pill.className = 'status-pill auto'; pill.textContent = '⏸ Sosta rilevata'; pb.textContent = '❚❚ Pausa'; pb.className = 'btn btn-warn'; }
    else { pill.className = 'status-pill'; pill.textContent = `● ${t.icon} In registrazione`; pb.textContent = '❚❚ Pausa'; pb.className = 'btn btn-warn'; }
  },
};

// ───────────────────────── Grafici (canvas) ─────────────────────────
function lineChart(canvas, tip, xs, ys, { color = '#5bd18b', fill = true, unitX = 'km', unitY = 'm', fmtX = (x) => (x / 1000).toFixed(2), onHover } = {}) {
  const draw = (hi = -1) => {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const vals = ys.filter((v) => v != null);
    if (vals.length < 2) { g.fillStyle = '#9bb3a3'; g.font = '13px system-ui'; g.fillText('Dati non disponibili', 10, 24); return; }
    let lo = Math.min(...vals), hi2 = Math.max(...vals); const pad = Math.max(5, (hi2 - lo) * 0.12); lo -= pad; hi2 += pad;
    const x0 = 38, y0 = 6, pw = w - x0 - 8, ph = h - y0 - 22;
    const xMax = xs[xs.length - 1] || 1, xMin = xs[0] || 0;
    const X = (x) => x0 + ((x - xMin) / ((xMax - xMin) || 1)) * pw, Y = (y) => y0 + ph - ((y - lo) / (hi2 - lo)) * ph;
    g.strokeStyle = '#2c4436'; g.fillStyle = '#9bb3a3'; g.font = '11px system-ui'; g.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi2 - lo) * k) / 3, y = Y(v);
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + pw, y); g.stroke(); g.fillText(Math.round(v), 2, y + 4);
    }
    for (let k = 0; k <= 4; k++) { const x = xMin + ((xMax - xMin) * k) / 4; g.fillText(fmtX(x) + (k === 4 ? ' ' + unitX : ''), Math.min(X(x) - 8, w - 50), h - 5); }
    g.beginPath(); let started = false;
    xs.forEach((x, i) => { if (ys[i] == null) return; started ? g.lineTo(X(x), Y(ys[i])) : (g.moveTo(X(x), Y(ys[i])), started = true); });
    g.strokeStyle = color; g.lineWidth = 2; g.stroke();
    if (fill) {
      g.lineTo(X(xMax), y0 + ph); g.lineTo(X(xs[ys.findIndex((v) => v != null)]), y0 + ph); g.closePath();
      const grad = g.createLinearGradient(0, y0, 0, y0 + ph); grad.addColorStop(0, color + '66'); grad.addColorStop(1, color + '05');
      g.fillStyle = grad; g.fill();
    }
    if (hi >= 0 && ys[hi] != null) {
      const x = X(xs[hi]); g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + ph); g.stroke();
      g.fillStyle = color; g.beginPath(); g.arc(x, Y(ys[hi]), 4, 0, 7); g.fill();
      tip.style.display = 'block'; tip.style.left = clamp(x, 50, w - 50) + 'px';
      tip.textContent = `${fmtX(xs[hi])} ${unitX} · ${Math.round(ys[hi])} ${unitY}`;
    } else tip.style.display = 'none';
    canvas._geo = { X, x0, pw, xMin, xMax };
  };
  const pick = (e) => {
    const r = canvas.getBoundingClientRect(), geo = canvas._geo; if (!geo) return;
    const x = geo.xMin + clamp((e.clientX - r.left - geo.x0) / geo.pw, 0, 1) * (geo.xMax - geo.xMin);
    let a = 0, b = xs.length - 1; while (b - a > 1) { const m = (a + b) >> 1; xs[m] < x ? (a = m) : (b = m); }
    const i = Math.abs(xs[a] - x) < Math.abs(xs[b] - x) ? a : b;
    draw(i); onHover?.(i);
  };
  canvas.onpointermove = pick; canvas.onpointerdown = pick;
  canvas.onpointerleave = () => { draw(); onHover?.(-1); };
  draw();
  return { draw };
}

// ───────────────────────── Dettaglio attività ─────────────────────────
const Detail = {
  map: null, layers: null, act: null, st: null, hoverMarker: null, charts: [],
  async open(id) {
    const act = await DB.get(id); if (!act) return;
    this.act = act; this.st = computeStats(act);
    $('#detail').classList.remove('hidden'); document.body.style.overflow = 'hidden';
    if (!this.map) {
      this.map = makeMap('detailMap', 'mapLayerDetail'); this.layers = L.layerGroup().addTo(this.map);
      $('#colorMode').onchange = () => this.drawTrack();
    }
    $('#detailName').value = act.name;
    const t = TYPES[act.type];
    $('#detailMeta').textContent = `${t.icon} ${t.label} · ${fmtDate(act.startTime)} · ${fmtTime(act.startTime)}–${fmtTime(act.endTime || act.startTime + act.totalMs)}${act.source === 'demo' ? ' · demo' : ''}${act.source === 'gpx' ? ' · importata' : ''}`;
    $('.detail-map').classList.toggle('hidden', act.points.length < 2);
    this.renderStats();
    setTimeout(() => { this.map.invalidateSize(); this.drawTrack(true); this.renderCharts(); }, 60);
  },
  close() { $('#detail').classList.add('hidden'); document.body.style.overflow = ''; this.act = null; },
  renderStats() {
    const a = this.act, st = this.st, t = TYPES[a.type];
    const cells = [
      ['Distanza', `${fmtKm(st.distance)}<small> km</small>`],
      ['Tempo in movimento', fmtDur(st.movingMs)],
      ['Tempo totale', fmtDur(st.totalMs)],
      ['In sosta', `${fmtDur(st.pausedMs)}<small> · ${st.autoPauses}×</small>`],
      [t.speedUnit === 'speed' ? 'Velocità media' : 'Passo medio', t.speedUnit === 'none' ? '--' : speedHtml(a.type, st.avgSpeed)],
      [t.speedUnit === 'speed' ? 'Velocità max' : 'Passo migliore', t.speedUnit === 'none' ? '--' : speedHtml(a.type, st.maxSpeed)],
      ['Dislivello +', `<span class="up">${Math.round(st.gain)}</span><small> m</small>`],
      ['Dislivello −', `<span class="down">${Math.round(st.loss)}</span><small> m</small>`],
      ['Quota max', st.altMax != null ? `${Math.round(st.altMax)}<small> m</small>` : '--'],
      ['Quota min', st.altMin != null ? `${Math.round(st.altMin)}<small> m</small>` : '--'],
      ['FC media', st.hrAvg ? `<span class="hr">${st.hrAvg}</span><small> bpm</small>` : '--'],
      ['FC max', st.hrMax ? `<span class="hr">${st.hrMax}</span><small> bpm</small>` : '--'],
      ['Calorie', `${st.kcal}<small> kcal</small>`],
      ['HRV (RMSSD)', st.rmssd ? `${st.rmssd}<small> ms</small>` : '--'],
    ];
    $('#detailStats').innerHTML = cells.map(([l, v]) => `<div class="stat"><span class="lbl">${l}</span><span class="val">${v}</span></div>`).join('');
    // parziali
    $('#splitsPanel').classList.toggle('hidden', !st.splits.length);
    $('#splitsBody').innerHTML = st.splits.map((s) => `<tr><td>${s.partial ? s.km : s.km}</td><td>${fmtDur(s.ms)}</td><td>${t.speedUnit === 'speed' ? fmtSpeed(s.dist / (s.ms / 1000)) + ' km/h' : fmtPace(s.dist / (s.ms / 1000))}</td><td>${s.dAlt == null ? '--' : (s.dAlt >= 0 ? '+' : '') + Math.round(s.dAlt)}</td><td>${s.hr || '--'}</td></tr>`).join('');
    // zone
    const tot = st.zoneMs.reduce((x, y) => x + y, 0);
    $('#hrPanel').classList.toggle('hidden', !a.hr?.length);
    $('#detailZones').innerHTML = tot ? zoneRows(st.zoneMs, tot) : '';
    $('#elevSrc').textContent = a.demApplied ? 'quote da DEM' : (st.altMax != null ? 'quote GPS' : '');
    $('#demBtn').disabled = a.points.length < 2;
  },
  drawTrack(fit) {
    const a = this.act, st = this.st, pts = a.points; this.layers.clearLayers(); this.hoverMarker = null;
    if (pts.length < 2) return;
    const mode = $('#colorMode').value;
    let val = null;
    if (mode === 'speed') {
      val = pts.map((p, i) => { const j = Math.max(0, i - 5); const dt = (p.mt - pts[j].mt) / 1000; return dt > 0 && p.seg === pts[j].seg ? (st.cum[i] - st.cum[j]) / dt : null; });
    } else if (mode === 'alt') val = st.alts;
    else if (mode === 'hr') val = pts.map((p) => p.hr ?? null);
    if (val && val.filter((v) => v != null).length > 2) {
      const sorted = val.filter((v) => v != null).sort((x, y) => x - y);
      const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.95)];
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].seg !== pts[i - 1].seg) continue;
        const v = val[i] ?? val[i - 1]; const c = v == null ? '#888' : rampColor((v - lo) / ((hi - lo) || 1));
        L.polyline([[pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]], { color: c, weight: 5, opacity: 0.95, interactive: false }).addTo(this.layers);
      }
    } else {
      const segs = []; let cur = [];
      pts.forEach((p, i) => { if (i && p.seg !== pts[i - 1].seg) { segs.push(cur); cur = []; } cur.push([p.lat, p.lon]); });
      segs.push(cur);
      L.polyline(segs, { color: '#0b1a10', weight: 8, opacity: 0.5, interactive: false }).addTo(this.layers);
      L.polyline(segs, { color: '#5bd18b', weight: 5, interactive: false }).addTo(this.layers);
    }
    const dot = (p, color, label) => L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).bindTooltip(label).addTo(this.layers);
    // marcatori km
    let k = 1;
    for (let i = 1; i < pts.length; i++) {
      if (st.cum[i] >= k * 1000) {
        L.marker([pts[i].lat, pts[i].lon], { icon: L.divIcon({ className: 'km-marker', html: k, iconSize: [22, 18] }), interactive: false }).addTo(this.layers);
        k++;
      }
    }
    // soste
    a.pauses.filter((p) => p.auto && p.lat != null).forEach((p) => {
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'pause-marker', html: 'Ⅱ', iconSize: [18, 18] }) })
        .bindTooltip(`Sosta ${fmtTime(p.start)} · ${fmtDurShort((p.end || p.start) - p.start)}`).addTo(this.layers);
    });
    dot(pts[0], '#5bd18b', 'Partenza'); dot(pts[pts.length - 1], '#ef6b5b', 'Arrivo');
    if (fit) this.map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])), { padding: [24, 24] });
  },
  hover(i) {
    const p = this.act?.points[i];
    if (i < 0 || !p) { this.hoverMarker && this.layers.removeLayer(this.hoverMarker); this.hoverMarker = null; return; }
    if (!this.hoverMarker) this.hoverMarker = L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 3, fillColor: '#3fa9ff', fillOpacity: 1 }).addTo(this.layers);
    else this.hoverMarker.setLatLng([p.lat, p.lon]);
  },
  renderCharts() {
    const a = this.act, st = this.st;
    const hasAlt = st.alts.some((v) => v != null) && a.points.length > 1;
    $('#elevPanel').classList.toggle('hidden', !hasAlt);
    this.charts = [];
    if (hasAlt) this.charts.push(lineChart($('#elevChart'), $('#elevTip'), Array.from(st.cum), st.alts, { color: '#f29b4b', onHover: (i) => this.hover(i) }));
    if (a.hr?.length) {
      // FC sulla distanza se c'è il GPS, altrimenti sul tempo
      if (a.points.length > 1 && a.points.some((p) => p.hr)) {
        this.charts.push(lineChart($('#hrChart'), $('#hrTip'), Array.from(st.cum), a.points.map((p) => p.hr ?? null), { color: '#ff5f7e', fill: false, unitY: 'bpm', onHover: (i) => this.hover(i) }));
      } else {
        const t0 = a.hr[0].t;
        this.charts.push(lineChart($('#hrChart'), $('#hrTip'), a.hr.map((h) => h.t - t0), a.hr.map((h) => h.bpm), { color: '#ff5f7e', fill: false, unitY: 'bpm', unitX: 'min', fmtX: (x) => Math.round(x / 60000) }));
      }
    }
  },
  async rename() {
    const a = this.act; if (!a) return; const v = $('#detailName').value.trim(); if (!v || v === a.name) return;
    a.name = v; await DB.put(a); History.load();
  },
  async remove() {
    if (!await confirmDlg(`Eliminare "${this.act.name}"?`, 'Elimina')) return;
    await DB.del(this.act.id); this.close(); History.load(); toast('Attività eliminata');
  },
  exportGpx() { const a = this.act; download(`${a.name.replace(/[^\w\- ]+/g, '').trim() || 'attivita'}.gpx`, toGpx(a), 'application/gpx+xml'); },
  async dem() {
    const a = this.act, btn = $('#demBtn'); btn.disabled = true; btn.textContent = '⛰ Scarico quote…';
    try {
      await applyDem(a);
      a.stats = statsSummary(computeStats(a)); await DB.put(a);
      this.st = computeStats(a); this.renderStats(); this.renderCharts(); if ($('#colorMode').value === 'alt') this.drawTrack();
      toast(`Quote corrette: +${Math.round(this.st.gain)} m / −${Math.round(this.st.loss)} m`);
      History.load();
    } catch (e) { toast('Impossibile scaricare le quote: ' + e.message, 4000); }
    btn.disabled = false; btn.textContent = '⛰ Correggi quote (DEM)';
  },
};
function zoneRows(zoneMs, tot) {
  return ZONES.map((z, i) => `<div class="zone-row"><b style="color:${z.color}">${z.name}</b><div class="zone-bar"><i style="width:${(100 * zoneMs[i] / tot).toFixed(1)}%;background:${z.color}"></i></div><span>${fmtDurShort(zoneMs[i])}</span></div>`).join('');
}

/* Quote dal modello digitale del terreno (Copernicus GLO-90 via Open-Meteo, gratuito, senza chiave). */
async function applyDem(act) {
  const pts = act.points; const step = Math.max(1, Math.ceil(pts.length / 1500));
  const idx = []; for (let i = 0; i < pts.length; i += step) idx.push(i);
  if (idx[idx.length - 1] !== pts.length - 1) idx.push(pts.length - 1);
  const elev = new Map();
  for (let k = 0; k < idx.length; k += 100) {
    const chunk = idx.slice(k, k + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map((i) => pts[i].lat).join(',')}&longitude=${chunk.map((i) => pts[i].lon).join(',')}`;
    const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(); j.elevation.forEach((e, n) => elev.set(chunk[n], e));
  }
  // interpolazione lineare per i punti non campionati
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1], ea = elev.get(a), eb = elev.get(b);
    for (let i = a; i <= b; i++) pts[i].dem = +(ea + ((eb - ea) * (i - a)) / ((b - a) || 1)).toFixed(1);
  }
  act.demApplied = true;
}

// ───────────────────────── GPX ─────────────────────────
function toGpx(a) {
  const segs = []; let cur = [];
  a.points.forEach((p, i) => { if (i && p.seg !== a.points[i - 1].seg) { segs.push(cur); cur = []; } cur.push(p); });
  if (cur.length) segs.push(cur);
  const pt = (p) => {
    const ele = altOf(a, p);
    return `      <trkpt lat="${p.lat}" lon="${p.lon}">${ele != null ? `<ele>${ele}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time>${p.hr ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>` : ''}</trkpt>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailTrack" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>${esc(a.name)}</name><time>${new Date(a.startTime).toISOString()}</time></metadata>
  <trk><name>${esc(a.name)}</name><type>${a.type}</type>
${segs.map((s) => `    <trkseg>\n${s.map(pt).join('\n')}\n    </trkseg>`).join('\n')}
  </trk>
</gpx>`;
}
function fromGpx(text, filename) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('file GPX non valido');
  const segs = [...doc.getElementsByTagName('trkseg')];
  const raw = []; segs.forEach((s, si) => [...s.getElementsByTagName('trkpt')].forEach((p) => {
    const t = p.getElementsByTagName('time')[0]?.textContent; const ele = p.getElementsByTagName('ele')[0]?.textContent;
    const hrEl = [...p.getElementsByTagName('*')].find((e) => e.localName === 'hr');
    raw.push({ lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon'), alt: ele != null ? +ele : null, t: t ? Date.parse(t) : null, hr: hrEl ? +hrEl.textContent : null, seg: si });
  }));
  if (raw.length < 2) throw new Error('nessun punto traccia');
  if (raw.some((p) => !p.t)) { const t0 = Date.now() - raw.length * 1000; raw.forEach((p, i) => (p.t = t0 + i * 1000)); }
  const name = doc.querySelector('trk > name')?.textContent || doc.querySelector('metadata > name')?.textContent || filename.replace(/\.gpx$/i, '');
  const typeTxt = (doc.querySelector('trk > type')?.textContent || '').toLowerCase();
  const type = TYPES[typeTxt] ? typeTxt : /run|corsa/.test(typeTxt) ? 'run' : /bik|cycl|bici/.test(typeTxt) ? 'bike' : /walk|cammin/.test(typeTxt) ? 'walk' : 'hike';
  // ricostruisce il tempo in movimento: intervalli > 30 s con spostamento minimo = sosta
  let mt = 0; const pauses = [];
  const points = raw.map((p, i) => {
    if (i) {
      const q = raw[i - 1], dt = p.t - q.t, d = haversine(q, p);
      if (p.seg === q.seg) { if (dt > 30000 && d / (dt / 1000) < 0.3) pauses.push({ start: q.t, end: p.t, auto: true, lat: q.lat, lon: q.lon }); else mt += dt; }
    }
    const o = { t: p.t, lat: p.lat, lon: p.lon, alt: p.alt, acc: 5, mt, seg: p.seg }; if (p.hr) o.hr = p.hr; return o;
  });
  const hr = points.filter((p) => p.hr).map((p) => ({ t: p.t, bpm: p.hr }));
  const act = { id: uid(), type, name, startTime: raw[0].t, endTime: raw[raw.length - 1].t, points, hr, rr: [], pauses, movingMs: mt, totalMs: raw[raw.length - 1].t - raw[0].t, seg: points[points.length - 1].seg, demApplied: false, source: 'gpx' };
  act.stats = statsSummary(computeStats(act));
  return act;
}

// ───────────────────────── Storico ─────────────────────────
const History = {
  items: [],
  async load() {
    this.items = (await DB.all()).sort((a, b) => b.startTime - a.startTime);
    this.render(); Health.renderSummary();
  },
  render() {
    const f = $('#historyFilter').value || 'all';
    const list = this.items.filter((a) => f === 'all' || a.type === f);
    const tot = list.reduce((s, a) => ({ d: s.d + a.stats.distance, g: s.g + a.stats.gain, m: s.m + a.stats.movingMs }), { d: 0, g: 0, m: 0 });
    $('#historyTotals').innerHTML = `<div><b>${list.length}</b><span>attività</span></div><div><b>${fmtKm(tot.d, 1)}</b><span>km</span></div><div><b>${Math.round(tot.g)}</b><span>m D+</span></div><div><b>${fmtDurShort(tot.m)}</b><span>in movimento</span></div>`;
    const box = $('#historyList');
    if (!list.length) { box.innerHTML = '<div class="empty">Nessuna attività ancora. Vai su <b>Registra</b> e premi Avvia!</div>'; return; }
    box.innerHTML = list.map((a) => {
      const t = TYPES[a.type], s = a.stats;
      return `<button class="h-item" data-id="${a.id}"><div class="h-icon">${t.icon}</div>
        <div style="min-width:0"><div class="h-title">${esc(a.name)}</div><div class="h-sub">${fmtDate(a.startTime)} · ${fmtTime(a.startTime)}</div>
        <div class="h-sub">${fmtDur(s.movingMs)} in mov. · ${Math.round(s.gain)} m D+${s.hrAvg ? ` · ♥ ${s.hrAvg}` : ''}</div></div>
        <div class="h-right"><b>${t.gps ? fmtKm(s.distance) + ' km' : fmtDurShort(s.totalMs)}</b><span class="h-sub">${t.gps && s.avgSpeed ? (t.speedUnit === 'speed' ? fmtSpeed(s.avgSpeed) + ' km/h' : fmtPace(s.avgSpeed) + ' /km') : `${s.kcal} kcal`}</span></div></button>`;
    }).join('');
    $$('.h-item', box).forEach((el) => (el.onclick = () => Detail.open(el.dataset.id)));
  },
  async importGpx(files) {
    let ok = 0;
    for (const f of files) {
      try { await DB.put(fromGpx(await f.text(), f.name)); ok++; } catch (e) { toast(`${f.name}: ${e.message}`, 4000); }
    }
    if (ok) { toast(`${ok} attività importate`); this.load(); }
  },
};

// ───────────────────────── Salute ─────────────────────────
const Health = {
  log: [], measuring: null,
  async init() {
    this.log = (await DB.kvGet('healthLog')) || [];
    HR.on(() => this.renderLive());
    $('#bandConnect').onclick = async () => {
      try { await HR.connect(); toast(`Collegato: ${HR.name}`); } catch (e) { if (e.name !== 'NotFoundError') toast(e.message, 4000); }
    };
    $('#bandDisconnect').onclick = () => HR.disconnect();
    $('#restMeasure').onclick = () => this.measureRest();
    this.renderLive(); this.renderLog();
  },
  renderLive() {
    const bpm = HR.fresh, z = bpm ? zoneOf(bpm) : -1;
    $('#hrLive').textContent = bpm || '--';
    $('#hrBadge').classList.toggle('hidden', !HR.connected);
    $('#hrBadgeVal').textContent = bpm || '--';
    const zEl = $('#hrZone');
    if (z >= 0) { zEl.textContent = `${ZONES[z].name} ${ZONES[z].label}`; zEl.style.background = ZONES[z].color + '33'; zEl.style.color = ZONES[z].color; }
    else zEl.textContent = '';
    if (bpm) { const h = $('#hrHeart'); h.classList.remove('beat'); void h.offsetWidth; h.classList.add('beat'); }
    $('#bandInfo').textContent = HR.connected ? `Collegato a ${HR.name}${HR.battery != null ? ` · batteria ${HR.battery}%` : ''}` : 'Nessun dispositivo collegato';
    $('#bandConnect').classList.toggle('hidden', HR.connected);
    $('#bandDisconnect').classList.toggle('hidden', !HR.connected);
    $('#hBatt').innerHTML = HR.battery != null ? `${HR.battery}<small> %</small>` : '--';
    const rm = calcRmssd(HR.rr.slice(-120));
    const last = this.log[0];
    $('#hHrv').innerHTML = rm ? `${rm}<small> ms</small>` : last?.rmssd ? `${last.rmssd}<small> ms</small>` : '--';
    $('#hRest').innerHTML = last ? `${last.rest}<small> bpm</small>` : '--';
    $('#hMax').innerHTML = `${maxHr()}<small> bpm${settings.maxHr ? '' : ' (stima)'}</small>`;
    $('#bandHint').textContent = settings.demo
      ? 'Modalità demo attiva: il battito è simulato.'
      : HR.supported
        ? 'Funziona con qualsiasi fascia/band che trasmette la frequenza cardiaca via Bluetooth standard (Polar, Garmin, Wahoo, Coros, Amazfit/Xiaomi con "Trasmissione FC" attiva…).'
        : 'Il tuo browser non supporta Web Bluetooth (es. Safari su iPhone). Usa Chrome su Android/PC, oppure importa i GPX con battito dall\'app della tua band (Storico → Importa GPX).';
  },
  async measureRest() {
    if (!HR.connected) { toast('Collega prima la band'); return; }
    if (this.measuring) return;
    const btn = $('#restMeasure'); const samples = []; const rrStart = HR.rr.length; let left = 60;
    const fn = () => { if (HR.fresh) samples.push(HR.fresh); };
    HR.on(fn);
    this.measuring = setInterval(async () => {
      left--; btn.textContent = `⏱ Misura in corso… ${left} s`;
      if (left > 0) return;
      clearInterval(this.measuring); this.measuring = null; HR.listeners.delete(fn);
      btn.textContent = '⏱ Misura FC a riposo e HRV (60 s)';
      if (samples.length < 20) { toast('Segnale insufficiente, riprova'); return; }
      const sorted = [...samples].sort((a, b) => a - b);
      const rest = Math.round(sorted.slice(0, Math.ceil(sorted.length * 0.3)).reduce((a, b) => a + b) / Math.ceil(sorted.length * 0.3));
      const rmssd = calcRmssd(HR.rr.slice(rrStart));
      this.log.unshift({ t: Date.now(), rest, rmssd }); this.log = this.log.slice(0, 60);
      await DB.kvSet('healthLog', this.log); this.renderLog(); this.renderLive();
      toast(`FC a riposo ${rest} bpm${rmssd ? ` · HRV ${rmssd} ms` : ''}`);
    }, 1000);
  },
  renderLog() {
    $('#healthLog').innerHTML = this.log.slice(0, 10).map((m) => `<div><span>${fmtDate(m.t)} ${fmtTime(m.t)}</span><span>♥ ${m.rest} bpm${m.rmssd ? ` · HRV ${m.rmssd} ms` : ''}</span></div>`).join('');
  },
  renderSummary() {
    const now = Date.now(), items = History.items;
    const per = (days) => {
      const l = items.filter((a) => a.startTime > now - days * 86400000);
      const hrA = l.filter((a) => a.stats.hrAvg);
      const zoneMs = ZONES.map((_, i) => l.reduce((s, a) => s + (a.stats.zoneMs?.[i] || 0), 0));
      return { n: l.length, d: l.reduce((s, a) => s + a.stats.distance, 0), g: l.reduce((s, a) => s + a.stats.gain, 0), m: l.reduce((s, a) => s + a.stats.movingMs, 0), k: l.reduce((s, a) => s + a.stats.kcal, 0), hr: hrA.length ? Math.round(hrA.reduce((s, a) => s + a.stats.hrAvg, 0) / hrA.length) : null, zoneMs };
    };
    const w = per(7), m = per(30);
    const cell = (l, v) => `<div class="stat"><span class="lbl">${l}</span><span class="val">${v}</span></div>`;
    const ztot = m.zoneMs.reduce((a, b) => a + b, 0);
    $('#healthSummary').innerHTML = `<h3>Ultimi 7 giorni</h3><div class="sum-grid">${cell('Attività', w.n)}${cell('Distanza', fmtKm(w.d, 1) + '<small> km</small>')}${cell('Dislivello +', Math.round(w.g) + '<small> m</small>')}${cell('Calorie', w.k + '<small> kcal</small>')}</div>
      <h3>Ultimi 30 giorni</h3><div class="sum-grid">${cell('In movimento', fmtDurShort(m.m))}${cell('Distanza', fmtKm(m.d, 1) + '<small> km</small>')}${cell('Dislivello +', Math.round(m.g) + '<small> m</small>')}${cell('FC media', m.hr ? m.hr + '<small> bpm</small>' : '--')}</div>
      ${ztot ? `<h3>Tempo nelle zone (30 gg)</h3><div class="zones">${zoneRows(m.zoneMs, ztot)}</div>` : ''}`;
    const mh = maxHr();
    $('#zoneLegend').innerHTML = ZONES.map((z, i) => `<div class="zone-row"><b style="color:${z.color}">${z.name}</b><span>${z.label}</span><span>${Math.round(z.from * mh)}–${i < 4 ? Math.round(ZONES[i + 1].from * mh) - 1 : mh}</span></div>`).join('');
  },
};

// ───────────────────────── Impostazioni ─────────────────────────
function saveSettings() { DB.kvSet('settings', settings).catch(() => {}); }
function initSettings() {
  const bind = (id, key, kind) => {
    const el = $(id);
    if (kind === 'bool') el.checked = !!settings[key]; else el.value = settings[key] ?? '';
    el.onchange = () => {
      settings[key] = kind === 'bool' ? el.checked : kind === 'num' ? (el.value === '' ? null : +el.value) : el.value;
      saveSettings();
      if (key === 'demo') { HR.disconnect(); UI.locateOnce(); }
      Health.renderLive(); Health.renderSummary();
    };
  };
  bind('#setWeight', 'weight', 'num'); bind('#setAge', 'age', 'num'); bind('#setSex', 'sex', 'str'); bind('#setMaxHr', 'maxHr', 'num');
  bind('#setAutoPause', 'autoPause', 'bool'); bind('#setWake', 'wake', 'bool'); bind('#setVibrate', 'vibrate', 'bool');
  bind('#setMaxAcc', 'maxAcc', 'num'); bind('#setDemo', 'demo', 'bool');
  $('#backupBtn').onclick = async () => {
    const data = { app: 'trailtrack', version: 1, exported: new Date().toISOString(), settings, healthLog: Health.log, activities: await DB.all() };
    download(`trailtrack-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  };
  $('#restoreInput').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'trailtrack') throw new Error('file non riconosciuto');
      for (const a of data.activities || []) await DB.put(a);
      if (data.healthLog?.length) { Health.log = data.healthLog; await DB.kvSet('healthLog', data.healthLog); }
      toast(`${data.activities?.length || 0} attività ripristinate`); History.load(); Health.renderLog();
    } catch (err) { toast('Ripristino fallito: ' + err.message, 4000); }
    e.target.value = '';
  };
}

// ───────────────────────── Navigazione & avvio ─────────────────────────
function showView(v) {
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'record') setTimeout(() => UI.map.invalidateSize(), 30);
}

async function main() {
  try { settings = { ...DEFAULT_SETTINGS, ...((await DB.kvGet('settings')) || {}) }; } catch { /* default */ }
  UI.init(); initSettings(); await Health.init();
  $$('.tabbar button').forEach((b) => (b.onclick = () => { Detail.act && Detail.close(); showView(b.dataset.view); }));
  const hf = $('#historyFilter');
  hf.innerHTML = '<option value="all">Tutte</option>' + Object.entries(TYPES).map(([k, t]) => `<option value="${k}">${t.icon} ${t.label}</option>`).join('');
  hf.onchange = () => History.render();
  $('#gpxImport').onchange = (e) => { History.importGpx([...e.target.files]); e.target.value = ''; };
  $('#detailBack').onclick = () => Detail.close();
  $('#detailName').onchange = () => Detail.rename();
  $('#detailMenuBtn').onclick = () => $('#gpxBtn').scrollIntoView({ behavior: 'smooth' });
  $('#gpxBtn').onclick = () => Detail.exportGpx();
  $('#deleteBtn').onclick = () => Detail.remove();
  $('#demBtn').onclick = () => Detail.dem();
  window.addEventListener('resize', () => Detail.act && Detail.charts.forEach((c) => c.draw()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Recorder.state) { Wake.on(); Recorder.tick(); }
    else if (Recorder.state) Recorder.save(true);
  });
  window.addEventListener('pagehide', () => Recorder.state && Recorder.save(true));
  await History.load();

  // recupero di un'attività interrotta (app chiusa, crash, batteria…)
  const cur = await DB.kvGet('current').catch(() => null);
  if (cur?.act) {
    const r = await dialog(`C'è un'attività in corso iniziata alle ${fmtTime(cur.act.startTime)} (${fmtKm(computeStats(cur.act).distance)} km).`, [
      { label: 'Scarta', value: 'discard', cls: 'btn-danger-ghost' }, { label: 'Salva e chiudi', value: 'save' }, { label: 'Riprendi', value: 'resume', cls: 'btn-primary' }]);
    if (r === 'resume') { await Recorder.restore(cur); UI.liveTrackRedraw(); }
    else if (r === 'save') { Recorder.state = { ...cur, buf: [] }; await Recorder.stop(); }
    else await DB.kvDel('current');
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
main();

// esposto per debug/test
window.TrailTrack = { Recorder, HR, DB, computeStats, fromGpx, toGpx, settings: () => settings };
