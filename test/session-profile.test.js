import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calculateValueArea, classifyOpening, indiaDateKey, latestSessionBefore, pruneSessions, readSessionArchive, writeSessionArchive } from '../lib/session-profile.js';

test('calculates the 70 percent value area from the POC outward', () => {
  const area = calculateValueArea([[100, 20], [101, 50], [102, 20], [103, 5], [104, 5]]);
  assert.deepEqual(area, { vah: 101, poc: 101, val: 100, totalVolume: 100 });
});

test('classifies the open above, below, and inside the previous value area', () => {
  const previousArea = { vah: 101, val: 100 };
  assert.equal(classifyOpening(101.05, previousArea), 'UP');
  assert.equal(classifyOpening(99.95, previousArea), 'DOWN');
  assert.equal(classifyOpening(100.5, previousArea), 'INSIDE');
  assert.equal(classifyOpening(null, previousArea), 'WAITING_OPEN');
  assert.equal(classifyOpening(100.5, null), 'WAITING_PRIOR_VALUE');
});

test('compares only with the latest earlier session that has a value area', () => {
  const sessions = {
    '2026-09-28': { NIFTY: { vah: 100, val: 90 }, SENSEX: { vah: 200, val: 190 } },
    '2026-09-29': { NIFTY: { vah: null, val: null } },
    '2026-09-30': { NIFTY: { vah: 110, val: 95 } },
    '2026-10-01': { NIFTY: { vah: 999, val: 1 } }
  };
  assert.deepEqual(latestSessionBefore(sessions, 'NIFTY', '2026-10-01'), {
    date: '2026-09-30', vah: 110, val: 95
  });
  assert.deepEqual(latestSessionBefore(sessions, 'SENSEX', '2026-10-01'), {
    date: '2026-09-28', vah: 200, val: 190
  });
});

test('uses India trading dates for UTC timestamps', () => {
  assert.equal(indiaDateKey(new Date('2026-10-01T18:30:00.000Z')), '2026-10-02');
});

test('keeps the latest 14 saved trading sessions', () => {
  const sessions = Object.fromEntries(Array.from({ length: 16 }, (_, index) => {
    const date = new Date('2026-10-01T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() - index);
    return [date.toISOString().slice(0, 10), { NIFTY: {} }];
  }));
  const retained = pruneSessions(sessions, '2026-10-01');
  assert.equal(Object.keys(retained).length, 14);
  assert.ok(retained['2026-09-18']);
  assert.equal(retained['2026-09-17'], undefined);
});

test('persists and restores session profiles from disk', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'market-session-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'data', 'session-profiles.json');
  const sessions = Object.fromEntries(Array.from({ length: 15 }, (_, index) => {
    const date = new Date('2026-10-01T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() - index);
    return [date.toISOString().slice(0, 10), { NIFTY: { vah: 100 + index, val: 90 + index, profile: { 95: 10 + index } } }];
  }));

  await writeSessionArchive(archivePath, sessions);
  const restored = await readSessionArchive(archivePath, '2026-10-01');

  assert.equal(Object.keys(restored).length, 14);
  assert.deepEqual(restored['2026-10-01'].NIFTY.profile, { 95: 10 });
  assert.equal(restored['2026-09-16'], undefined);
});
