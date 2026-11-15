// Tests for changes.js — per-cell owner-change dates from the daily snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChanges, changesText, writeChanges } from './changes.js';

const A = '881e3a0001fffff', B = '881e3a0003fffff', C = '881e3a0005fffff';
const day = (date, clubs, unnamed = {}) => ({ date, doc: { date, clubs, unnamed } });
const days = [
  day('2026-10-08', { c1: { cells: [A, B] } }),
  day('2026-10-09', { c1: { cells: [A] }, c2: { cells: [B] } }),          // B taken by c2
  day('2026-10-10', { c1: { cells: [A] } }, { '#FFDC16': [C] }),          // B unclaimed, C claimed (unnamed)
  day('2026-10-11', { c1: { cells: [A, C] } }),                           // C: unnamed -> c1
];

test('buildChanges: a date for every owner change, incl. becoming unclaimed', () => {
  const { first, last, cells } = buildChanges(days);
  assert.equal(first, '2026-10-08');
  assert.equal(last, '2026-10-11');
  assert.deepEqual(cells.get(A), ['2026-10-08']);
  assert.deepEqual(cells.get(B), ['2026-10-08', '2026-10-09', '2026-10-10']);
  assert.deepEqual(cells.get(C), ['2026-10-10', '2026-10-11']);
});

test('buildChanges: docs can be loaded lazily', () => {
  const lazy = days.map((d) => ({ date: d.date, doc: () => d.doc }));
  assert.deepEqual(buildChanges(lazy).cells, buildChanges(days).cells);
});

test('changesText: valid JSON, cells sorted, one per line', () => {
  const text = changesText(buildChanges(days));
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc.cells), [A, B, C]);
  assert.ok(text.includes(`\n    "${A}": ["2026-10-08"],\n`));
  assert.ok(text.endsWith('}\n'));
});

test('writeChanges: reads the days listed in index.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floaty-changes-'));
  const index = [];
  for (const d of days) {
    const file = `daily/2026/${d.date}.json`;
    fs.mkdirSync(path.join(dir, 'daily/2026'), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(d.doc));
    index.push({ date: d.date, file });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ days: index }));
  assert.deepEqual(writeChanges(dir), { cells: 3, bytes: fs.statSync(path.join(dir, 'changes.json')).size });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'changes.json'), 'utf8')).cells[B], ['2026-10-08', '2026-10-09', '2026-10-10']);
  assert.ok(!fs.existsSync(path.join(dir, 'changes.json.tmp')));
});
