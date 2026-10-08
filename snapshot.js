#!/usr/bin/env node
// Take today's world territory snapshot and write it into the repo:
//   daily/YYYY/YYYY-MM-DD.json   one file per day (UTC date of the run)
//   latest.json                  the newest snapshot — its git history is a
//                                day-by-day diff of who gained/lost which cell
//   index.json                   every day on file with its totals (the web
//                                page's date list)
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

// Rebuild index.json from the daily/ files: entries already in the index are
// kept, others are read from their file, and `doc` (the snapshot just taken)
// always replaces its own day.
export function updateIndex(outDir, doc) {
  const indexFile = path.join(outDir, 'index.json');
  const known = {};
  try { for (const d of JSON.parse(fs.readFileSync(indexFile, 'utf8')).days) known[d.date] = d; } catch {}
  const entry = (d, file) => ({ date: d.date, takenAt: d.takenAt, cells: d.totals.cells, clubs: d.totals.clubs, file });
  const days = [];
  const dailyDir = path.join(outDir, 'daily');
  const years = fs.existsSync(dailyDir) ? fs.readdirSync(dailyDir).filter((y) => /^\d{4}$/.test(y)).sort() : [];
  for (const year of years) {
    for (const f of fs.readdirSync(path.join(dailyDir, year)).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort()) {
      const date = f.slice(0, 10), file = `daily/${year}/${f}`;
      if (doc && doc.date === date) days.push(entry(doc, file));
      else if (known[date]) days.push({ ...known[date], file });
      else days.push(entry(JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8')), file));
    }
  }
  fs.writeFileSync(indexFile + '.tmp', JSON.stringify({ days }, null, 2) + '\n');
  fs.renameSync(indexFile + '.tmp', indexFile);
  return days;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
  const t0 = Date.now();
  const takenAt = new Date();
  const world = await fetchWorld({ log: (m) => console.log(m) });
  const doc = snapshotDoc(world, takenAt);
  const { dayFile, bytes } = writeSnapshot(outDir, doc);
  updateIndex(outDir, doc);
  console.log(`${doc.totals.cells} cells, ${doc.totals.clubs} clubs`
    + (doc.totals.unnamedCells ? `, ${doc.totals.unnamedCells} unnamed` : '')
    + ` — ${world.stats.requests} requests, ${(world.stats.bytes / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`
    + ` → ${path.relative(outDir, dayFile)} (${(bytes / 1e6).toFixed(2)} MB)`);
}
