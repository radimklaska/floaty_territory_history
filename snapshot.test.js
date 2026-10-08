// Tests for snapshot.js — the document shape and the files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotDoc, writeSnapshot, updateIndex } from './snapshot.js';

const world = {
  cells: 3,
  clubs: { c1: { name: 'One', color: '#22C55E', cells: ['881e3a0001fffff', '881e3a0003fffff'] } },
  unnamed: { '#FFDC16': ['881e3a0005fffff'] },
  stats: { requests: 1025, bytes: 1234, tiles: 1025 },
};

test('snapshotDoc: UTC date, totals, no fetch stats', () => {
  const doc = snapshotDoc(world, new Date('2026-10-08T23:59:00Z'));
  assert.equal(doc.date, '2026-10-08');
  assert.deepEqual(doc.totals, { cells: 3, clubs: 1, unnamedCells: 1 });
  assert.equal(doc.h3Res, 8);
  assert.ok(!('stats' in doc));
  assert.deepEqual(doc.clubs, world.clubs);
});

test('writeSnapshot: daily/YYYY/YYYY-MM-DD.json + identical latest.json, one cell per line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floaty-history-'));
  const doc = snapshotDoc(world, new Date('2026-10-08T00:17:00Z'));
  const { dayFile } = writeSnapshot(dir, doc);
  assert.equal(path.relative(dir, dayFile), path.join('daily', '2026', '2026-10-08.json'));
  const text = fs.readFileSync(dayFile, 'utf8');
  assert.equal(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'), text);
  assert.deepEqual(JSON.parse(text), doc);
  assert.ok(text.split('\n').some((l) => l.trim() === '"881e3a0001fffff",'));   // each cell on its own line
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(fs.readdirSync(path.dirname(dayFile)), ['2026-10-08.json']); // no .tmp left behind
});

test('updateIndex: lists every daily file in order, reuses known entries, refreshes the current day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floaty-history-'));
  const d1 = snapshotDoc(world, new Date('2025-12-31T00:17:00Z'));
  const d2 = snapshotDoc({ ...world, cells: 4 }, new Date('2026-01-01T00:17:00Z'));
  writeSnapshot(dir, d1);
  writeSnapshot(dir, d2);
  const days = updateIndex(dir, d2);
  assert.deepEqual(days.map((d) => [d.date, d.cells, d.file]), [
    ['2025-12-31', 3, 'daily/2025/2025-12-31.json'],
    ['2026-01-01', 4, 'daily/2026/2026-01-01.json'],
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).days, days);
  // a re-run of the same day replaces only that day's entry
  const again = updateIndex(dir, snapshotDoc({ ...world, cells: 5 }, new Date('2026-01-01T09:00:00Z')));
  assert.deepEqual(again.map((d) => d.cells), [3, 5]);
});
