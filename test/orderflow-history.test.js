import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeOrderflowHistory, readOrderflowHistory, writeOrderflowHistory } from '../lib/orderflow-history.js';
import { selectFuturesContract } from '../lib/futures-contract.js';

function candle(time, close, levels = []) {
  return {
    time,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 100,
    positiveVolume: 60,
    negativeVolume: 40,
    delta: 20,
    cvd: 20,
    levels
  };
}

test('merges footprint candles by timestamp and retains only two session dates', () => {
  let history = {};
  const firstTime = Date.parse('2026-10-01T04:00:00+05:30');
  history = mergeOrderflowHistory(history, {
    date: '2026-10-01',
    instrument: 'NIFTY',
    orderflow: {
      symbol: 'NSE:NIFTY26OCTFUT',
      updatedAt: '2026-10-01T04:05:00.000Z',
      candles: { 5: [candle(firstTime, 100, [{ price: 99, positiveVolume: 8, negativeVolume: 2 }])] },
      profile: [{ price: 100, volume: 50 }],
      valueArea: { vah: 100, poc: 100, val: 100, totalVolume: 50 },
      cvd: 20
    }
  });
  history = mergeOrderflowHistory(history, {
    date: '2026-10-01',
    instrument: 'NIFTY',
    orderflow: {
      symbol: 'NSE:NIFTY26OCTFUT',
      updatedAt: '2026-10-01T04:10:00.000Z',
      candles: { 5: [candle(firstTime, 101), candle(firstTime + 300000, 102)] },
      profile: [],
      valueArea: null,
      cvd: null
    }
  });

  assert.equal(history['2026-10-01'].NIFTY.candles[5].length, 2);
  assert.equal(history['2026-10-01'].NIFTY.candles[5][0].close, 101);
  assert.equal(history['2026-10-01'].NIFTY.candles[5][0].levels[0].positiveVolume, 8);
  assert.deepEqual(history['2026-10-01'].NIFTY.profile, [{ price: 100, volume: 50 }]);

  for (const date of ['2026-10-02', '2026-10-05']) {
    history = mergeOrderflowHistory(history, {
      date,
      instrument: 'NIFTY',
      orderflow: { symbol: 'NSE:NIFTY26OCTFUT', updatedAt: `${date}T04:10:00.000Z`, candles: {}, profile: [] }
    });
  }

  assert.deepEqual(Object.keys(history), ['2026-10-02', '2026-10-05']);
});

test('persists and reloads order-flow history atomically as JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'legend-orderflow-history-'));
  const filePath = path.join(directory, 'nested', 'history.json');
  const history = {
    '2026-10-02': {
      NIFTY: {
        candles: { 5: [candle(Date.parse('2026-10-02T04:00:00+05:30'), 100, [{ price: 99, positiveVolume: 10, negativeVolume: 5 }])] },
        profile: [{ price: 100, volume: 20 }]
      }
    }
  };

  try {
    await writeOrderflowHistory(filePath, history);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), history);
    assert.deepEqual(await readOrderflowHistory(filePath, '2026-10-02'), history);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('selects and exposes the nearest active contract expiry from the FYERS symbol master', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const records = [
    ['id', 'NIFTY 27 OCT 26 FUT', '', '', '0.05', '', '', '', String(Date.parse('2026-10-27T10:00:00Z') / 1000), 'NSE:NIFTY26OCTFUT'],
    ['id', 'NIFTY 24 NOV 26 FUT', '', '', '0.05', '', '', '', String(Date.parse('2026-11-24T10:00:00Z') / 1000), 'NSE:NIFTY26NOVFUT']
  ];

  const automatic = selectFuturesContract(records, 'NIFTY', '', now);
  const configured = selectFuturesContract(records, 'NIFTY', 'NSE:NIFTY26NOVFUT', now);
  assert.equal(automatic.symbol, 'NSE:NIFTY26OCTFUT');
  assert.equal(automatic.description, 'NIFTY 27 OCT 26 FUT');
  assert.equal(automatic.expiryDate, '2026-10-27');
  assert.equal(automatic.expired, false);
  assert.equal(configured.symbol, 'NSE:NIFTY26NOVFUT');
  assert.equal(configured.expiryDate, '2026-11-24');
});

test('falls forward to the nearest active contract when the configured expiry has passed', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const records = [
    ['id', 'NIFTY 27 OCT 26 FUT', '', '', '0.05', '', '', '', String(Date.parse('2026-10-27T10:00:00Z') / 1000), 'NSE:NIFTY26OCTFUT'],
    ['id', 'NIFTY 24 NOV 26 FUT', '', '', '0.05', '', '', '', String(Date.parse('2026-11-24T10:00:00Z') / 1000), 'NSE:NIFTY26NOVFUT']
  ];

  const selected = selectFuturesContract(records, 'NIFTY', 'NSE:NIFTY26OCTFUT', now);

  assert.equal(selected.symbol, 'NSE:NIFTY26NOVFUT');
  assert.equal(selected.expiryDate, '2026-11-24');
  assert.equal(selected.expired, false);
  assert.equal(selected.source, 'NEAREST_EXPIRY');
});
