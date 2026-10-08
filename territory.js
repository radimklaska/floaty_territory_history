// Floaty club territory — fetch and decode the whole world's claimed hexagons.
//
// Floaty (the onewheel/PEV riding app) lets clubs claim H3 resolution-8 cells
// (~0.5 km across) by riding through them. The app draws territory from public
// Mapbox vector tiles on its CDN — no login:
//   https://cdn.floaty-app.com/territory-tiles/{z}/{x}/{y}.pbf   (zooms 5–14)
// Each tile has one layer, "territory":
//   - a polygon per claimed cell, props { color, isCell: true } — no cell id,
//     clipped at the tile edge;
//   - from z10 up, a point per cell with { clubName, clubId, color, isLabel }.
// Unclaimed cells are absent; tiles with no territory are 404.
//
// A snapshot of the world:
//   1. all 1024 z5 tiles (mostly 404s) list every claimed cell, colour only;
//   2. the z10 tile holding each cell's centre (its "home" tile, where its
//      label point is) gives the club id and name.
// Polygons are mapped back to H3 ids via their centroid (a clipped hexagon's
// centroid is still inside it).

import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import { latLngToCell, cellToLatLng } from 'h3-js';

export const TILE_URL = 'https://cdn.floaty-app.com/territory-tiles';
export const H3_RES = 8;
export const DISCOVERY_Z = 5;      // lowest zoom with data; complete cell lists
export const NAMES_Z = 10;         // lowest zoom whose tiles carry club names

const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat, z) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);

// colours are upstream data: accept plain hex colours only
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : '#888888');

// the z10 tile whose area holds the cell's centre
export function homeTile(h3) {
  const [lat, lon] = cellToLatLng(h3);
  return `${NAMES_Z}/${tileX(lon, NAMES_Z)}/${tileY(lat, NAMES_Z)}`;
}

// Decode one tile into { z, x, y, cells: [[h3, color, clubId|null], …], clubs: {clubId: {name, color}} }.
// A buffered edge cell can lack its label in this tile; then it gets the one
// club in this tile using its colour, or null (buildSnapshot prefers the
// cell's home tile anyway).
export function decodeTile(buf, z, x, y) {
  const layer = new VectorTile(new Protobuf(buf)).layers.territory;
  const cells = new Map();           // h3 -> color
  const cellClub = new Map();        // h3 -> clubId
  const clubs = {};
  if (layer) {
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const p = f.properties;
      const g = f.toGeoJSON(x, y, z).geometry;
      if (p.isLabel && g.type === 'Point' && p.clubId) {
        const [lon, lat] = g.coordinates;
        const id = String(p.clubId);
        cellClub.set(latLngToCell(lat, lon, H3_RES), id);
        clubs[id] = { name: String(p.clubName || ''), color: safeColor(p.color) };
      } else if (p.isCell && g.type === 'Polygon') {
        const ring = g.coordinates[0].slice(0, -1);          // drop the closing vertex
        if (!ring.length) continue;
        let lon = 0, lat = 0;
        for (const c of ring) { lon += c[0]; lat += c[1]; }
        cells.set(latLngToCell(lat / ring.length, lon / ring.length, H3_RES), safeColor(p.color));
      }
    }
  }
  const byColor = new Map();         // color -> clubId | null (ambiguous)
  for (const [id, c] of Object.entries(clubs)) byColor.set(c.color, byColor.has(c.color) ? null : id);
  return {
    z, x, y,
    cells: [...cells].map(([h, color]) => [h, color, cellClub.get(h) ?? byColor.get(color) ?? null]),
    clubs,
  };
}

// Merge the z5 cell lists (complete, colour only) with the z10 tiles (names):
//   { cells, clubs: { <clubId>: { name, color, cells: [h3…] } }, unnamed: { <color>: [h3…] } }
// Clubs are keyed and cells sorted so consecutive snapshots diff cleanly.
export function mergeTiles(discovery, names) {
  const cells = new Map();           // h3 -> { color, clubId, home }
  for (const t of discovery) for (const [h, color] of t.cells) cells.set(h, { color, clubId: null, home: false });
  const clubs = {};
  for (const t of names) {
    const key = `${t.z}/${t.x}/${t.y}`;
    for (const [id, c] of Object.entries(t.clubs)) clubs[id] = { name: c.name, color: c.color, cells: [] };
    for (const [h, color, clubId] of t.cells) {
      const home = homeTile(h) === key;
      const cur = cells.get(h);
      if (!cur) cells.set(h, { color, clubId, home });               // newer than the z5 tile — still real
      else if (clubId && (home || (!cur.home && !cur.clubId))) Object.assign(cur, { color, clubId, home });
    }
  }
  const unnamed = {};
  for (const [h, c] of [...cells].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (c.clubId && clubs[c.clubId]) clubs[c.clubId].cells.push(h);
    else (unnamed[c.color] ||= []).push(h);
  }
  const sorted = {};
  for (const id of Object.keys(clubs).sort()) if (clubs[id].cells.length) sorted[id] = clubs[id];
  return { cells: cells.size, clubs: sorted, unnamed };
}

// small promise pool: fn over items, at most `limit` at a time
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Fetch the whole world. Throws if any tile still fails after 3 attempts —
// a snapshot is all or nothing.
export async function fetchWorld({ fetchImpl = fetch, concurrency = 8, retryDelayMs = 2000, log = () => {} } = {}) {
  const stats = { requests: 0, bytes: 0 };
  async function getTile([z, x, y]) {
    const key = `${z}/${x}/${y}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const resp = await fetchImpl(`${TILE_URL}/${key}.pbf`, { signal: AbortSignal.timeout(30_000) });
        stats.requests++;
        if (resp.status === 404) { await resp.arrayBuffer(); return { z, x, y, cells: [], clubs: {} }; }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        stats.bytes += buf.length;
        return decodeTile(buf, z, x, y);
      } catch (e) {
        if (attempt >= 3) throw new Error(`tile ${key}: ${e.message || e}`);
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      }
    }
  }
  const z5 = [];
  for (let x = 0; x < 2 ** DISCOVERY_Z; x++) for (let y = 0; y < 2 ** DISCOVERY_Z; y++) z5.push([DISCOVERY_Z, x, y]);
  const discovery = await mapLimit(z5, concurrency, getTile);
  const nameKeys = new Set();
  for (const t of discovery) for (const [h] of t.cells) nameKeys.add(homeTile(h));
  log(`z${DISCOVERY_Z}: ${discovery.filter((t) => t.cells.length).length} tiles with territory; fetching ${nameKeys.size} z${NAMES_Z} tiles for club names`);
  const names = await mapLimit([...nameKeys].map((k) => k.split('/').map(Number)), concurrency, getTile);
  return { ...mergeTiles(discovery, names), stats: { ...stats, tiles: z5.length + nameKeys.size } };
}
