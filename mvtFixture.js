// Test helper: a minimal Mapbox Vector Tile encoder for synthetic Floaty
// territory tiles (layer "territory"), so tests never need real club data.
//   encodeTile([{ type: 'cell' | 'label', h3, props }], z, x, y) -> Uint8Array
// 'cell' draws the H3 cell's hexagon as a polygon, 'label' a point at its centre.
import Pbf from 'pbf';
import { cellToBoundary, cellToLatLng } from 'h3-js';

const EXTENT = 4096;
const zz = (n) => (n << 1) ^ (n >> 31);                  // zigzag for geometry params

export function encodeTile(features, z, tx, ty) {
  const toTile = ([lat, lon]) => [
    Math.round((((lon + 180) / 360) * 2 ** z - tx) * EXTENT),
    Math.round((((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z - ty) * EXTENT),
  ];
  const keys = [], values = [];
  const idx = (arr, v) => { let i = arr.indexOf(v); if (i < 0) { i = arr.length; arr.push(v); } return i; };
  const encoded = features.map((f, id) => {
    const tags = [];
    for (const [k, v] of Object.entries(f.props)) tags.push(idx(keys, k), idx(values, v));
    let geometry;
    if (f.type === 'cell') {                              // MoveTo, LineTo×n, ClosePath
      const pts = cellToBoundary(f.h3).map(toTile);
      geometry = [1 | (1 << 3), zz(pts[0][0]), zz(pts[0][1]), 2 | ((pts.length - 1) << 3)];
      for (let i = 1; i < pts.length; i++) geometry.push(zz(pts[i][0] - pts[i - 1][0]), zz(pts[i][1] - pts[i - 1][1]));
      geometry.push(7 | (1 << 3));
    } else {
      const [x, y] = toTile(cellToLatLng(f.h3));
      geometry = [1 | (1 << 3), zz(x), zz(y)];
    }
    return { id: id + 1, tags, type: f.type === 'cell' ? 3 : 1, geometry };
  });
  const pbf = new Pbf();
  pbf.writeMessage(3, (_, p) => {                          // Tile.layers
    p.writeVarintField(15, 2);                             // version
    p.writeStringField(1, 'territory');
    for (const f of encoded) p.writeMessage(2, (ft, q) => {
      q.writeVarintField(1, ft.id);
      q.writePackedVarint(2, ft.tags);
      q.writeVarintField(3, ft.type);
      q.writePackedVarint(4, ft.geometry);
    }, f);
    for (const k of keys) p.writeStringField(3, k);
    for (const v of values) p.writeMessage(4, (val, q) => {
      if (typeof val === 'boolean') q.writeBooleanField(7, val); else q.writeStringField(1, val);
    }, v);
    p.writeVarintField(5, EXTENT);
  }, null);
  return pbf.finish();
}
