#!/usr/bin/env node
// Take today's world territory snapshot and write it into the repo:
//   daily/YYYY/YYYY-MM-DD.json   one file per day (UTC date of the run)
//   latest.json                  the newest snapshot — its git history is a
//                                day-by-day diff of who gained/lost which cell
// Pretty-printed, one cell per line, clubs and cells sorted, so diffs stay
// readable. Nothing is written unless every tile loaded.
//
// Usage: node snapshot.js [outDir]   (default: this directory)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWorld, TILE_URL, H3_RES } from './territory.js';

export function snapshotDoc(world, takenAt) {
  const unnamed = Object.values(world.unnamed).reduce((n, a) => n + a.length, 0);
  return {
    date: takenAt.toISOString().slice(0, 10),
    takenAt: takenAt.toISOString(),
    source: TILE_URL,
    h3Res: H3_RES,
    totals: { cells: world.cells, clubs: Object.keys(world.clubs).length, unnamedCells: unnamed },
    clubs: world.clubs,
    unnamed: world.unnamed,
  };
}

export function writeSnapshot(outDir, doc) {
  const text = JSON.stringify(doc, null, 2) + '\n';
  const dayFile = path.join(outDir, 'daily', doc.date.slice(0, 4), `${doc.date}.json`);
  for (const file of [dayFile, path.join(outDir, 'latest.json')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', text);
    fs.renameSync(file + '.tmp', file);
  }
  return { dayFile, bytes: Buffer.byteLength(text) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
  const t0 = Date.now();
  const takenAt = new Date();
  const world = await fetchWorld({ log: (m) => console.log(m) });
  const doc = snapshotDoc(world, takenAt);
  const { dayFile, bytes } = writeSnapshot(outDir, doc);
  console.log(`${doc.totals.cells} cells, ${doc.totals.clubs} clubs`
    + (doc.totals.unnamedCells ? `, ${doc.totals.unnamedCells} unnamed` : '')
    + ` — ${world.stats.requests} requests, ${(world.stats.bytes / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`
    + ` → ${path.relative(outDir, dayFile)} (${(bytes / 1e6).toFixed(2)} MB)`);
}
