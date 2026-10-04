import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProfileBins, calculateValueArea, classifyOpening, detectLowVolumeZones, indiaDateKey, latestSessionBefore, pruneSessions, readSessionArchive, untestedHistoricalLowVolumeZones, writeSessionArchive } from '../lib/session-profile.js';

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

test('detects current low-volume zones and classifies their value-area location', () => {
  const levels = [
    { price: 97, high: 98, volume: 100 },
    { price: 98, high: 99, volume: 100 },
    { price: 99, high: 100, volume: 5 },
    { price: 100, high: 101, volume: 100 },
    { price: 101, high: 102, volume: 100 },
    { price: 102, high: 103, volume: 5 },
    { price: 103, high: 104, volume: 100 },
    { price: 104, high: 105, volume: 100 },
    { price: 105, high: 106, volume: 100 }
  ];
  const zones = detectLowVolumeZones(levels, { vah: 102, val: 98 });

  assert.deepEqual(zones.map(({ low, high, valueAreaStatus }) => ({ low, high, valueAreaStatus })), [
    { low: 99, high: 100, valueAreaStatus: 'INSIDE' },
    { low: 102, high: 103, valueAreaStatus: 'OUTSIDE' }
  ]);
});

test('detects LVNs across empty price buckets using nearest traded neighbors', () => {
  const levels = [
    { price: 99, high: 100, volume: 100 },
    { price: 100, high: 101, volume: 0 },
    { price: 101, high: 102, volume: 10 },
    { price: 102, high: 103, volume: 0 },
    { price: 103, high: 104, volume: 100 }
  ];
  const zones = detectLowVolumeZones(levels, { vah: 104, val: 99 });

  assert.deepEqual(zones.map(({ low, high }) => ({ low, high })), [{ low: 101, high: 102 }]);
});

test('keeps only untested historical LVNs within the seven-day lookback', () => {
  const previousProfile = Object.fromEntries([
    [97, 100], [98, 100], [99, 5], [100, 100], [101, 100], [102, 5], [103, 100], [104, 100], [105, 100]
  ]);
  const sessions = {
    '2026-09-24': { NIFTY: { vah: 104, val: 98, profile: previousProfile } },
    '2026-09-25': { NIFTY: { vah: 104, val: 98, profile: previousProfile } },
    '2026-10-02': { NIFTY: { profile: { 99: 10 } } }
  };
  const zones = untestedHistoricalLowVolumeZones(sessions, 'NIFTY', '2026-10-02', [[99, 10]], 1);

  assert.deepEqual(zones.map(({ date, low, high }) => ({ date, low, high })), [
    { date: '2026-09-25', low: 102, high: 103 }
  ]);
  assert.deepEqual(buildProfileBins([[100, 10], [101, 30], [102, 10]], 1), [
    { price: 100, high: 101, volume: 10 },
    { price: 101, high: 102, volume: 30 },
    { price: 102, high: 103, volume: 10 }
  ]);
});

test('keeps the latest seven saved trading sessions', () => {
  const sessions = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
    const date = new Date('2026-10-01T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() - index);
    return [date.toISOString().slice(0, 10), { NIFTY: {} }];
  }));
  const retained = pruneSessions(sessions, '2026-10-01');
  assert.equal(Object.keys(retained).length, 7);
  assert.ok(retained['2026-09-25']);
  assert.equal(retained['2026-09-24'], undefined);
});

test('persists and restores session profiles from disk', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'market-session-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, 'data', 'session-profiles.json');
  const sessions = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
    const date = new Date('2026-10-01T00:00:00.000Z');
    date.setUTCDate(date.getUTCDate() - index);
    return [date.toISOString().slice(0, 10), { NIFTY: { vah: 100 + index, val: 90 + index, profile: { 95: 10 + index } } }];
  }));

  await writeSessionArchive(archivePath, sessions);
  const restored = await readSessionArchive(archivePath, '2026-10-01');

  assert.equal(Object.keys(restored).length, 7);
  assert.deepEqual(restored['2026-10-01'].NIFTY.profile, { 95: 10 });
  assert.equal(restored['2026-09-24'], undefined);
});
