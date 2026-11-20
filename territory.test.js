// Tests for territory.js. Run with: npm test (node --test).
// Tiles are synthetic (mvtFixture.js), so no real club data is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, gridDisk } from 'h3-js';
import { decodeTile, mergeTiles, fetchWorld, homeTile, H3_RES } from './territory.js';
import { encodeTile } from './mvtFixture.js';

// a cell at the exact centre of the Prague z10 tile 553/346 (z5 tile 17/10), and neighbours
const tileCentre = (z, x, y) => {
  const n = 2 ** z;
  return [(Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI, ((x + 0.5) / n) * 360 - 180];
};
const A = latLngToCell(...tileCentre(10, 553, 346), H3_RES);
const [B, C] = gridDisk(A, 1).filter((h) => h !== A);

test('decodeTile: polygons -> H3 cells, labels -> clubs, colour fallback, colour sanitising', () => {
  const buf = encodeTile([
    { type: 'cell', h3: A, props: { color: '#22C55E', isCell: true } },
    { type: 'label', h3: A, props: { clubName: 'One', clubId: 'c1', color: '#22C55E', isLabel: true } },
    { type: 'cell', h3: B, props: { color: '#22C55E', isCell: true } },
    { type: 'cell', h3: C, props: { color: 'red;background:url(x)', isCell: true } },
  ], 10, 553, 346);
  const d = decodeTile(buf, 10, 553, 346);
  assert.deepEqual(d.clubs, { c1: { name: 'One', color: '#22C55E' } });
  assert.deepEqual(new Map(d.cells.map(([h, color, club]) => [h, [color, club]])),
    new Map([[A, ['#22C55E', 'c1']], [B, ['#22C55E', 'c1']], [C, ['#888888', null]]]));
  assert.equal(homeTile(A), '10/553/346');
});

test('mergeTiles: home tile names win over a neighbour guess, gaps stay unnamed, sorted output', () => {
  const discovery = [{ z: 5, x: 17, y: 10, cells: [[A, '#22C55E'], [B, '#FFDC16']], clubs: {} }];
  const home = { z: 10, x: 553, y: 346, cells: [[A, '#22C55E', 'c1'], [C, '#22C55E', 'c1']],
    clubs: { c1: { name: 'One', color: '#22C55E' } } };
  const neighbour = { z: 10, x: 554, y: 346, cells: [[A, '#22C55E', 'c2']],
    clubs: { c2: { name: 'Two', color: '#22C55E' } } };
  for (const names of [[home, neighbour], [neighbour, home]]) {
    const m = mergeTiles(discovery, names);
    assert.deepEqual(m.clubs, { c1: { name: 'One', color: '#22C55E', cells: [A, C].sort() } });
    assert.deepEqual(m.unnamed, { '#FFDC16': [B] });
    assert.equal(m.cells, 3);
  }
});

// fake CDN: the z5 tile over A and B (17/10) is empty, like Floaty's z5 tile
// over Taiwan; its z6 child 34/21 has both cells, and their z10 home tile names
// them. 404 elsewhere.
function fakeCdn({ failKey } = {}) {
  const tiles = {
    '5/17/10': encodeTile([], 5, 17, 10),
    '6/34/21': encodeTile([
      { type: 'cell', h3: A, props: { color: '#22C55E', isCell: true } },
      { type: 'cell', h3: B, props: { color: '#FFDC16', isCell: true } },
    ], 6, 34, 21),
    '10/553/346': encodeTile([
      { type: 'cell', h3: A, props: { color: '#22C55E', isCell: true } },
      { type: 'label', h3: A, props: { clubName: 'One', clubId: 'c1', color: '#22C55E', isLabel: true } },
      { type: 'cell', h3: B, props: { color: '#FFDC16', isCell: true } },
      { type: 'label', h3: B, props: { clubName: 'Two', clubId: 'c2', color: '#FFDC16', isLabel: true } },
    ], 10, 553, 346),
  };
  const calls = [];
  const fetchImpl = async (url) => {
    const key = url.match(/(\d+\/\d+\/\d+)\.pbf$/)[1];
    calls.push(key);
    if (key === failKey) throw new Error('boom');
    return tiles[key] ? new Response(tiles[key], { status: 200 }) : new Response('NoSuchKey', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('fetchWorld: every z5 tile, the z6 tiles under the ones that are not 404 (even if empty), then the z10 home tiles', async () => {
  const cdn = fakeCdn();
  const w = await fetchWorld({ fetchImpl: cdn.fetchImpl });
  assert.equal(cdn.calls.filter((k) => k.startsWith('5/')).length, 1024);
  assert.deepEqual(cdn.calls.filter((k) => k.startsWith('6/')).sort(), ['6/34/20', '6/34/21', '6/35/20', '6/35/21']);
  assert.deepEqual(cdn.calls.filter((k) => k.startsWith('10/')), ['10/553/346']);
  assert.deepEqual(Object.fromEntries(Object.entries(w.clubs).map(([id, c]) => [id, [c.name, c.cells]])),
    { c1: ['One', [A]], c2: ['Two', [B]] });
  assert.deepEqual(w.unnamed, {});
  assert.equal(w.stats.requests, 1024 + 4 + 1);
  assert.equal(w.stats.tiles, 1024 + 4 + 1);
});

test('fetchWorld: a tile that keeps failing rejects the whole snapshot (after 3 attempts)', async () => {
  const cdn = fakeCdn({ failKey: '10/553/346' });
  await assert.rejects(fetchWorld({ fetchImpl: cdn.fetchImpl, retryDelayMs: 1 }), /tile 10\/553\/346: boom/);
  assert.equal(cdn.calls.filter((k) => k === '10/553/346').length, 3);
});
