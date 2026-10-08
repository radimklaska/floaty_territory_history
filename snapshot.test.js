// Tests for snapshot.js — the document shape and the files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotDoc, writeSnapshot } from './snapshot.js';

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
