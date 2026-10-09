// Floaty territory history — map viewer for the daily snapshots in this repo.
//
// Loads index.json (the list of days) and one daily/YYYY/YYYY-MM-DD.json at a
// time, and draws every claimed H3 cell on a canvas GridLayer: dots when
// zoomed out, hexagons from HEX_ZOOM, one label per contiguous same-club patch
// from LABEL_ZOOM, and the faint unclaimed grid from GRID_ZOOM. Click a club
// (list or map) to highlight it. The previous day is loaded too, for the
// change column of the club list and for "show only changes", which greys out
// every cell the previous day already had under the same club. State lives in
// the URL hash:
//   #d=<date>&c=<clubId>&diff=1&m=<zoom>/<lat>/<lng>

const { L, h3 } = window;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');      // Number(): a string can't smuggle HTML in
// colours end up in inline styles: plain hex only (no CSS injection)
const hex = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : '#888888');

const RES = 8;
const HEX_ZOOM = 9;          // below: each cell is a small square (a hexagon would be ~2 px)
const LABEL_ZOOM = 10;
const GRID_ZOOM = 12;        // a cell is ~40 px wide here
const PAD_KM = 0.7;          // > a cell's circumradius (~0.53 km)
const GREY = '#8a94a3';      // greyed-out cells: other clubs while one is selected, unchanged cells in diff mode

// GitHub Pages serves only docs/; the snapshots are read from the repo itself
// (raw.githubusercontent.com allows cross-origin reads). ?data=<path> points at
// a copy on the page's own origin, e.g. ?data=../ when serving the repo root
// locally — never another site, so a crafted link can't feed the page data.
const Q = new URLSearchParams(location.search);
const DATA = (() => {
  if (Q.get('data')) {
    const u = new URL(Q.get('data'), location.href);
    if (u.origin === location.origin) return u.href;
  }
  const owner = location.hostname.match(/^([^.]+)\.github\.io$/)?.[1];
  const repo = location.pathname.split('/')[1];
  return owner && repo
    ? `https://raw.githubusercontent.com/${owner}/${repo}/main/`
    : 'https://raw.githubusercontent.com/radimklaska/floaty_territory_history/main/';
})();

// ---------- map ----------
const map = L.map('map', { worldCopyJump: true, minZoom: 2 }).setView([35, 0], 2);
const OSM_ATTR = '© OpenStreetMap';
const baseLayers = {
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTR }),
  'Dark (Esri)': L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 16, attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap' }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 16 }),
  ]),
  'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
  'CyclOSM': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', { maxZoom: 20, attribution: OSM_ATTR + ' · CyclOSM' }),
};
let baseName = 'Dark (Esri)';                      // colours pop on dark; the choice is remembered
try { if (baseLayers[localStorage.getItem('fth.base')]) baseName = localStorage.getItem('fth.base'); } catch {}
baseLayers[baseName].addTo(map);
L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', (e) => { try { localStorage.setItem('fth.base', e.name); } catch {} });

// ---------- collapsible panel ----------
const appEl = $('app');
const setCollapsed = (c) => {
  appEl.classList.toggle('collapsed', c);
  try { localStorage.setItem('fth.collapsed', c ? '1' : '0'); } catch {}
  map.invalidateSize();
};
try { if (localStorage.getItem('fth.collapsed') === '1') appEl.classList.add('collapsed'); } catch {}
$('collapse').onclick = () => setCollapsed(true);
$('menu').onclick = () => setCollapsed(false);

// ---------- geometry caches (shared across days: most cells persist) ----------
const centres = new Map();   // h3 -> [lat, lng]
const rings = new Map();     // h3 -> [[lat, lng]…]
const centre = (h) => { let c = centres.get(h); if (!c) centres.set(h, (c = h3.cellToLatLng(h))); return c; };
const ring = (h) => { let r = rings.get(h); if (!r) rings.set(h, (r = h3.cellToBoundary(h))); return r; };

// ---------- snapshot data ----------
let days = [];               // index.json entries, oldest first
let cur = null;              // the prepared snapshot on screen
let focus = null;            // highlighted club or null
let prevSnap = null;         // the previous day's snapshot once loaded (null on the first day, or until it arrives)
let diffPrev = null;         // prevSnap while "show only changes" is on, else null
let deltas = new Map();      // club id -> cells gained (+) or lost (-) since the previous day
const loaded = new Map();    // date -> prepared snapshot (a few kept)

// clubs (biggest first) + h3 -> club + 1°×1° buckets of cells for tile queries
function prepare(doc) {
  const clubs = [];
  for (const [id, c] of Object.entries(doc.clubs)) clubs.push({ id, name: String(c.name), color: hex(c.color), cells: c.cells });
  for (const [color, cells] of Object.entries(doc.unnamed || {})) clubs.push({ id: 'unnamed:' + color, name: 'unknown club', color: hex(color), cells });
  clubs.sort((a, b) => b.cells.length - a.cells.length);
  const cellClub = new Map();
  const buckets = new Map(); // "lat:lng" -> { la, lo, cells }
  for (const club of clubs) for (const h of club.cells) {
    cellClub.set(h, club);
    const [lat, lng] = centre(h);
    const la = Math.floor(lat), lo = Math.floor(lng), k = la + ':' + lo;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { la, lo, cells: [] }));
    b.cells.push(h);
  }
  return { date: doc.date, takenAt: doc.takenAt, totals: doc.totals, clubs, cellClub, buckets };
}

function padded(bounds, km = PAD_KM) {
  const n = bounds.getNorth(), s = bounds.getSouth();
  const dLat = km / 111, dLon = dLat / Math.max(0.1, Math.cos((((n + s) / 2) * Math.PI) / 180));
  return { n: n + dLat, s: s - dLat, w: bounds.getWest() - dLon, e: bounds.getEast() + dLon };
}

// claimed cells whose centre is inside the box
function cellsIn(b) {
  const out = [];
  if (!cur) return out;
  const la0 = Math.floor(b.s), la1 = Math.floor(b.n), lo0 = Math.floor(b.w), lo1 = Math.floor(b.e);
  const take = (bk) => {
    for (const h of bk.cells) {
      const [lat, lng] = centre(h);
      if (lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e) out.push(h);
    }
  };
  if ((la1 - la0 + 1) * (lo1 - lo0 + 1) > cur.buckets.size) {       // big box: scan the occupied buckets
    for (const bk of cur.buckets.values()) if (bk.la >= la0 && bk.la <= la1 && bk.lo >= lo0 && bk.lo <= lo1) take(bk);
  } else {
    for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) { const bk = cur.buckets.get(la + ':' + lo); if (bk) take(bk); }
  }
  return out;
}

// grey instead of the club colour: other clubs while one is selected, and in
// diff mode every cell the previous day already had under the same club
const dimmed = (h, club) => (focus !== null && club !== focus) || (diffPrev !== null && diffPrev.cellClub.get(h)?.id === club.id);

// ---------- canvas tiles ----------
function drawTile(ctx, coords, size) {
  const z = coords.z;
  const nw = coords.scaleBy(size);
  const box = padded(L.latLngBounds(map.unproject(nw, z), map.unproject(nw.add(size), z)));
  const pt = (ll) => map.project(ll, z).subtract(nw);
  const path = (h) => {
    const r = ring(h);
    for (let i = 0; i < r.length; i++) { const p = pt(r[i]); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
    ctx.closePath();
  };

  const greyed = new Map(), coloured = new Map();              // club -> cells
  for (const h of cellsIn(box)) {
    const club = cur.cellClub.get(h);
    const m = dimmed(h, club) ? greyed : coloured;
    let hs = m.get(club);
    if (!hs) m.set(club, (hs = []));
    hs.push(h);
  }

  if (z >= GRID_ZOOM && $('grid').checked) {                  // unclaimed: faint outlines only
    ctx.beginPath();
    for (const h of h3.polygonToCells([[box.n, box.w], [box.n, box.e], [box.s, box.e], [box.s, box.w]], RES))
      if (!cur.cellClub.has(h)) path(h);
    ctx.strokeStyle = 'rgba(128,138,152,.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // [club, cells, dim]: grey first, so the coloured cells draw on top
  const groups = [...[...greyed].map(([c, hs]) => [c, hs, true]), ...[...coloured].map(([c, hs]) => [c, hs, false])];
  const hl = focus !== null || diffPrev !== null;              // something is highlighted: the colour pops more
  if (z < HEX_ZOOM) {
    const lat = (box.n + box.s) / 2;
    const kmPx = (2 ** z * 256) / (40075 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    const s = Math.max(2, 0.95 * kmPx);                         // ~1 km wide, at least 2 px
    for (const [club, hs, dim] of groups) {
      ctx.globalAlpha = dim ? 0.45 : 0.9;
      ctx.fillStyle = dim ? GREY : club.color;
      for (const h of hs) { const p = pt(centre(h)); ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s); }
    }
  } else {
    ctx.lineJoin = 'round';
    for (const [club, hs, dim] of groups) {
      ctx.beginPath();
      for (const h of hs) path(h);
      ctx.globalAlpha = dim ? 0.22 : hl ? 0.55 : 0.35;
      ctx.fillStyle = dim ? GREY : club.color;
      ctx.fill();
      if (z >= 11) {
        ctx.globalAlpha = dim ? 0.35 : 0.85;
        ctx.strokeStyle = dim ? GREY : club.color;
        ctx.lineWidth = dim ? 1 : 1.2;
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}

const Territory = L.GridLayer.extend({
  createTile(coords) {
    const size = this.getTileSize();
    const dpr = window.devicePixelRatio || 1;
    const canvas = L.DomUtil.create('canvas', 'leaflet-tile');
    canvas.width = size.x * dpr;
    canvas.height = size.y * dpr;
    if (cur) {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTile(ctx, coords, size);
    }
    return canvas;
  },
});
map.createPane('hexPane').style.zIndex = 350;
map.createPane('hexLabelPane').style.zIndex = 360;
map.getPane('hexLabelPane').style.pointerEvents = 'none';
const grid = new Territory({ pane: 'hexPane', noWrap: true, updateWhenZooming: false, keepBuffer: 2,
  attribution: 'Territory: <a href="https://floaty-app.com/">Floaty</a>' }).addTo(map);

// ---------- labels: one per contiguous same-club patch in view ----------
const labels = L.layerGroup().addTo(map);
let labelTimer = 0;
const scheduleLabels = () => { clearTimeout(labelTimer); labelTimer = setTimeout(drawLabels, 120); };
function drawLabels() {
  labels.clearLayers();
  if (!cur || map.getZoom() < LABEL_ZOOM) return;
  const visible = new Set(cellsIn(padded(map.getBounds())).filter((h) => !dimmed(h, cur.cellClub.get(h))));   // coloured cells only
  if (visible.size > 40_000) return;
  const patches = [];
  const seen = new Set();
  for (const start of visible) {
    if (seen.has(start)) continue;
    const club = cur.cellClub.get(start);
    const members = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const h = queue.pop();
      members.push(h);
      for (const n of h3.gridDisk(h, 1)) {
        if (seen.has(n) || !visible.has(n) || cur.cellClub.get(n) !== club) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    let lat = 0, lng = 0;
    for (const h of members) { const c = centre(h); lat += c[0]; lng += c[1]; }
    lat /= members.length; lng /= members.length;
    let anchor = members[0], best = Infinity;                  // the member nearest the patch centre
    for (const h of members) {
      const c = centre(h), d = (c[0] - lat) ** 2 + (c[1] - lng) ** 2;
      if (d < best) { best = d; anchor = h; }
    }
    patches.push({ club, anchor, size: members.length });
  }
  patches.sort((a, b) => b.size - a.size);                     // biggest first; skip overlapping labels
  const placed = [];
  const view = map.getSize();
  for (const p of patches) {
    const ll = centre(p.anchor);
    const pt = map.latLngToContainerPoint(ll);
    const w = p.club.name.length * 6.5 + 26, hgt = 20;
    const r = { x0: pt.x - w / 2, x1: pt.x + w / 2, y0: pt.y - hgt / 2, y1: pt.y + hgt / 2 };
    if (r.x1 < 0 || r.y1 < 0 || r.x0 > view.x || r.y0 > view.y) continue;
    if (placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) continue;
    placed.push(r);
    L.marker(ll, {
      pane: 'hexLabelPane', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'hex-label', iconSize: null,
        html: `<span class="chip"><span class="sw" style="background:${esc(p.club.color)}"></span>${esc(p.club.name)}</span>` }),
    }).addTo(labels);
    if (placed.length >= 80) break;
  }
}

// ---------- hover + click on the map ----------
const tip = L.tooltip({ direction: 'top', offset: [0, -6], className: 'tip', opacity: 1 });
const cellAt = (latlng) => (cur && map.getZoom() >= HEX_ZOOM ? h3.latLngToCell(latlng.lat, latlng.lng, RES) : null);
const clubAt = (latlng) => { const h = cellAt(latlng); return h ? cur.cellClub.get(h) : null; };
let hoverAt = 0;
map.on('mousemove', (e) => {
  const t = performance.now();
  if (t - hoverAt < 50) return;
  hoverAt = t;
  const h = cellAt(e.latlng), club = h && cur.cellClub.get(h);
  if (!club) { map.closeTooltip(tip); return; }
  let change = '';                                             // diff mode: how the cell differs from the previous day
  if (diffPrev) { const was = diffPrev.cellClub.get(h); change = !was ? ' · new' : was.id !== club.id ? ` · was ${esc(was.name)}` : ''; }
  tip.setLatLng(e.latlng).setContent(`<span class="sw" style="background:${esc(club.color)}"></span><b>${esc(club.name)}</b> <span class="n">${fmt(club.cells.length)} cells${change}</span>`);
  if (!map.hasLayer(tip)) tip.addTo(map);
});
map.on('mouseout', () => map.closeTooltip(tip));
map.on('click', (e) => {
  if (map.getZoom() < HEX_ZOOM) return;
  const club = clubAt(e.latlng);
  setFocus(club && club !== focus ? club : null, false);
});

// ---------- panel ----------
function setFocus(club, fit) {
  focus = club;
  $('focus').hidden = !club;
  if (club) $('focus').querySelector('b').textContent = club.name;
  renderClubs();
  grid.redraw();
  scheduleLabels();
  writeHash();
  if (club && fit) map.fitBounds(coreBounds(club.cells).pad(0.05), { maxZoom: 13 });
}

// bounds of the bulk of a club's cells (2nd–98th percentile in each axis), so
// a few cells far from home don't zoom the map out to a whole continent
function coreBounds(cells) {
  const lats = cells.map((h) => centre(h)[0]).sort((a, b) => a - b);
  const lngs = cells.map((h) => centre(h)[1]).sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  const k = cells.length >= 50 ? 0.02 : 0;
  return L.latLngBounds([q(lats, k), q(lngs, k)], [q(lats, 1 - k), q(lngs, 1 - k)]);
}
$('unfocus').onclick = (e) => { e.preventDefault(); setFocus(null, false); };

// ---------- club list: sortable by name, cells, change ----------
const SORT_KEYS = { name: false, cells: true, delta: true };  // column -> descending by default
let sort = { by: 'cells', desc: true };                        // remembered across visits
try { const s = JSON.parse(localStorage.getItem('fth.sort')); if (s && s.by in SORT_KEYS) sort = { by: s.by, desc: !!s.desc }; } catch {}
function setSort(by) {                                         // the same column again flips the direction
  sort = { by, desc: sort.by === by ? !sort.desc : SORT_KEYS[by] };
  try { localStorage.setItem('fth.sort', JSON.stringify(sort)); } catch {}
  renderClubs();
}
for (const b of $('cols').querySelectorAll('button')) b.onclick = () => setSort(b.dataset.sort);
const primary = {                                              // ascending; the direction is applied on top
  name: (a, b) => a.name.trim().localeCompare(b.name.trim(), undefined, { sensitivity: 'base' }),
  cells: (a, b) => a.cells.length - b.cells.length,
  delta: (a, b) => (deltas.get(a.id) || 0) - (deltas.get(b.id) || 0),
};
const tiebreak = (a, b) => b.cells.length - a.cells.length || a.name.localeCompare(b.name);

function renderClubs() {
  for (const b of $('cols').querySelectorAll('button')) {
    const on = b.dataset.sort === sort.by;
    b.classList.toggle('on', on);
    b.textContent = b.dataset.label + (on ? (sort.desc ? ' ▾' : ' ▴') : '');
  }
  const list = $('clubs');
  list.textContent = '';
  if (!cur) return;
  const pending = !prevSnap && days.findIndex((d) => d.date === cur.date) > 0;   // the previous day is still loading
  const q = $('search').value.trim().toLowerCase();
  const rows = cur.clubs.filter((c) => !q || c.name.toLowerCase().includes(q));
  rows.sort((a, b) => (sort.desc ? -1 : 1) * primary[sort.by](a, b) || tiebreak(a, b));
  const frag = document.createDocumentFragment();
  for (const club of rows) {
    const d = deltas.get(club.id);                             // undefined until the previous day is in
    const change = d === undefined ? (pending ? '…' : '') : d > 0 ? '+' + fmt(d) : fmt(d);
    const li = document.createElement('li');
    li.className = club === focus ? 'on' : '';
    li.innerHTML = `<span class="sw" style="background:${esc(club.color)}"></span><span class="name">${esc(club.name)}</span>`
      + `<span class="n">${fmt(club.cells.length)}</span><span class="d${d > 0 ? ' pos' : d < 0 ? ' neg' : ''}">${change}</span>`;
    li.title = `${club.name} — ${fmt(club.cells.length)} cells` + (d === undefined ? '' : `, ${change} since ${prevSnap.date}`);
    li.onclick = () => setFocus(club === focus ? null : club, club !== focus);
    frag.appendChild(li);
  }
  list.appendChild(frag);
  alignCols();
}
// keep the column headers clear of the list's scrollbar (which comes and goes with the layout)
function alignCols() { const list = $('clubs'); $('table').style.setProperty('--sbw', list.offsetWidth - list.clientWidth + 'px'); }
window.addEventListener('resize', alignCols);
$('search').addEventListener('input', renderClubs);
$('grid').addEventListener('change', () => grid.redraw());
$('diff').addEventListener('change', () => setDiff($('diff').checked));

function renderTotals() {
  const i = days.findIndex((d) => d.date === cur.date);
  const prev = i > 0 ? days[i - 1] : null;
  const delta = prev ? cur.totals.cells - prev.cells : null;
  const deltaTxt = delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${fmt(delta)} vs ${esc(prev.date)})`;
  let diffTxt = '';
  if (diffPrev) {                                              // what is in colour
    let gained = 0, taken = 0;
    for (const [h, club] of cur.cellClub) { const was = diffPrev.cellClub.get(h); if (!was) gained++; else if (was.id !== club.id) taken++; }
    diffTxt = `<br>in colour: <b>${fmt(gained)}</b> newly claimed, <b>${fmt(taken)}</b> changed hands`;
  }
  $('totals').innerHTML = `<b>${fmt(cur.totals.cells)}</b> cells${deltaTxt} · <b>${fmt(cur.totals.clubs)}</b> clubs<br>`
    + `taken ${esc(String(cur.takenAt).slice(0, 16).replace('T', ' '))} UTC` + diffTxt;
  $('prev').disabled = i <= 0;
  $('diff').disabled = i <= 0;                                 // the first day has nothing to compare against
  $('diffLabel').title = i <= 0 ? 'No earlier snapshot to compare with.' : $('diffLabel').dataset.title;
  $('next').disabled = i < 0 || i >= days.length - 1;
}

// ---------- date navigation ----------
let loadToken = 0;
async function loadSnap(entry) {                               // from the cache (kept most-recently-used), or fetched
  let snap = loaded.get(entry.date);
  if (!snap) {
    try {
      const r = await fetch(DATA + entry.file);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      snap = prepare(await r.json());
    } catch (e) {
      throw new Error(`Couldn't load ${entry.date}: ${e.message || e}`);
    }
  }
  loaded.delete(entry.date);
  loaded.set(entry.date, snap);
  if (loaded.size > 4) loaded.delete(loaded.keys().next().value);
  return snap;
}
// the previous day's snapshot (or null): the change column, and the grey cells in diff mode
function setPrev(snap) {
  prevSnap = snap;
  diffPrev = snap && $('diff').checked ? snap : null;
  deltas = new Map();
  if (snap) {
    const was = new Map(snap.clubs.map((c) => [c.id, c.cells.length]));
    for (const c of cur.clubs) deltas.set(c.id, c.cells.length - (was.get(c.id) || 0));
  }
}
function setDiff(on) {
  $('diff').checked = on;
  if (!cur) return;
  setPrev(prevSnap);
  renderTotals();
  grid.redraw();
  scheduleLabels();
  writeHash();
}
// show a day. Its previous day is loaded too: before anything is drawn when
// diff mode needs it for the grey, otherwise afterwards, for the change column.
async function loadDate(date) {
  if (!days.length) return;
  let i = days.findIndex((d) => d.date === date);
  if (i < 0) i = days.length - 1;
  const entry = days[i], before = i > 0 ? days[i - 1] : null;
  const token = ++loadToken;
  $('date').value = entry.date;
  if (!loaded.has(entry.date)) $('totals').textContent = `Loading ${entry.date}…`;
  let snap, early = null;
  try {
    snap = await loadSnap(entry);
    if (before && $('diff').checked) early = await loadSnap(before);   // read after the await: the box may have been ticked meanwhile
  } catch (e) {
    if (token === loadToken) $('totals').textContent = e.message;
    return;
  }
  if (token !== loadToken) return;
  cur = snap;
  if (focus) focus = cur.clubs.find((c) => c.id === focus.id) || null;   // keep the highlight across days
  $('focus').hidden = !focus;
  setPrev(early);
  renderTotals();
  renderClubs();
  grid.redraw();
  scheduleLabels();
  writeHash();
  if (!before || early) return;
  let late;
  try {
    late = await loadSnap(before);
  } catch (e) {
    if (token === loadToken) $('totals').insertAdjacentHTML('beforeend', `<br>${esc(e.message)}`);
    return;
  }
  if (token !== loadToken) return;
  setPrev(late);
  renderTotals();
  renderClubs();
  if (diffPrev) { grid.redraw(); scheduleLabels(); }         // the box was ticked while it loaded
}
const step = (d) => {
  const i = days.findIndex((x) => x.date === cur?.date) + d;
  if (i >= 0 && i < days.length) loadDate(days[i].date);
};
$('date').onchange = () => loadDate($('date').value);
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === 'ArrowLeft' && e.altKey) step(-1);
  if (e.key === 'ArrowRight' && e.altKey) step(1);
});

// ---------- URL hash state ----------
function writeHash() {
  const p = new URLSearchParams();
  if (cur) p.set('d', cur.date);
  if (focus) p.set('c', focus.id);
  if ($('diff').checked) p.set('diff', '1');
  const c = map.getCenter();
  p.set('m', `${map.getZoom()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`);
  history.replaceState(null, '', '#' + p.toString().replaceAll('%2F', '/'));
}
map.on('moveend', () => { scheduleLabels(); writeHash(); });

// ---------- start ----------
function hashView() {
  const h = new URLSearchParams(location.hash.slice(1));
  const [z, lat, lng] = (h.get('m') || '').split('/').map(Number);
  return { h, view: h.get('m') && [z, lat, lng].every(Number.isFinite) ? { z, lat, lng } : null };
}
// a link pasted into an already-open tab (or back/forward) changes only the hash
window.addEventListener('hashchange', async () => {
  const { h, view } = hashView();
  if (view) map.setView([view.lat, view.lng], view.z);
  const diff = h.get('diff') === '1';
  if (h.get('d') && h.get('d') !== cur?.date) { $('diff').checked = diff; await loadDate(h.get('d')); }
  else if (diff !== $('diff').checked) setDiff(diff);
  const club = h.get('c') ? cur?.clubs.find((c) => c.id === h.get('c')) : null;
  if ((club || null) !== focus) setFocus(club || null, !view);
});

(async () => {
  const { h, view } = hashView();
  const haveView = !!view;
  if (view) map.setView([view.lat, view.lng], view.z);
  try {
    const r = await fetch(DATA + 'index.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    days = (await r.json()).days || [];
  } catch (e) {
    $('totals').textContent = `Couldn't load the snapshot list: ${e.message || e}`;
    return;
  }
  if (!days.length) { $('totals').textContent = 'No snapshots yet.'; return; }
  for (const d of [...days].reverse()) {
    const o = document.createElement('option');
    o.value = d.date;
    o.textContent = `${d.date} · ${fmt(d.cells)} cells`;
    $('date').appendChild(o);
  }
  $('diff').checked = h.get('diff') === '1';
  await loadDate(h.get('d') || days[days.length - 1].date);
  if (cur && h.get('c')) {
    const club = cur.clubs.find((c) => c.id === h.get('c'));
    if (club) setFocus(club, !haveView);
  }
  if (cur && !haveView && !focus) {                     // first visit: frame all the territory
    const b = L.latLngBounds([]);
    for (const bk of cur.buckets.values()) b.extend([bk.la + 0.5, bk.lo + 0.5]);
    if (b.isValid()) map.fitBounds(b, { maxZoom: 12 });
  }
})();
