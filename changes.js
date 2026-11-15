#!/usr/bin/env node
// Build changes.json from the daily/ files: for every cell ever claimed, the
// dates its owner changed (claimed, taken by another club, or unclaimed), so
// the web map can say when a cell last changed hands without loading every day.
//
//   { "first": "2026-10-08", "last": "2026-11-15",
//     "cells": { "881e3a0001fffff": ["2026-10-08", "2026-11-03"], … } }
//
// A date is the first snapshot that showed the new owner (days can be missing).
// "first" is the first snapshot: a cell whose last change is that day has had
// its owner since then or earlier. One cell per line, sorted, so diffs stay
// readable. Rebuilt from scratch each time, so it heals itself.
//
// Usage: node changes.js [outDir]   (default: this directory)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// owner key per cell: the club id, or unnamed:<colour> as in the web map
function owners(doc) {
  const m = new Map();
  for (const [id, c] of Object.entries(doc.clubs)) for (const h of c.cells) m.set(h, id);
  for (const [color, cells] of Object.entries(doc.unnamed || {})) for (const h of cells) m.set(h, 'unnamed:' + color);
  return m;
}

// days: [{ date, doc }] in date order (doc may be loaded lazily via a function)
export function buildChanges(days) {
  const cells = new Map();                                     // h3 -> [dates]
  let prev = new Map();
  for (const { date, doc } of days) {
    const cur = owners(typeof doc === 'function' ? doc() : doc);
    for (const [h, owner] of cur) if (prev.get(h) !== owner) push(cells, h, date);
    for (const h of prev.keys()) if (!cur.has(h)) push(cells, h, date);   // unclaimed now
    prev = cur;
  }
  return { first: days[0]?.date ?? null, last: days.at(-1)?.date ?? null, cells };
}
function push(cells, h, date) { let a = cells.get(h); if (!a) cells.set(h, (a = [])); a.push(date); }

export function changesText({ first, last, cells }) {
  const lines = [...cells.keys()].sort().map((h) => `    ${JSON.stringify(h)}: ${JSON.stringify(cells.get(h))}`);
  return `{\n  "first": ${JSON.stringify(first)},\n  "last": ${JSON.stringify(last)},\n  "cells": {\n${lines.join(',\n')}\n  }\n}\n`;
}

// read the days listed in index.json, write changes.json next to it
export function writeChanges(outDir) {
  const { days } = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  const changes = buildChanges(days.map((d) => ({ date: d.date, doc: () => JSON.parse(fs.readFileSync(path.join(outDir, d.file), 'utf8')) })));
  const file = path.join(outDir, 'changes.json');
  const text = changesText(changes);
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
  return { cells: changes.cells.size, bytes: Buffer.byteLength(text) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
  const { cells, bytes } = writeChanges(outDir);
  console.log(`changes.json: ${cells} cells, ${(bytes / 1e6).toFixed(2)} MB`);
}
