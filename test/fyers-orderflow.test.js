import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeFyersOrderflow } from '../lib/fyers-orderflow.js';

test('normalizes FYERS footprint candles and infers timeframe', () => {
  const result = mergeFyersOrderflow(null, {
    symbol: 'NSE:NIFTY26OCTFUT',
    endpoint: '/orderflow/footprint',
    payload: {
      code: 200,
      data: [
        [1800000000, 100, 103, 99, 102, 1200, 0, 700, 500, 200, null, null, null, [[101, 300, 100]]],
        [1800000900, 102, 104, 101, 103, 1500, 0, 900, 600, 300, null, null, null, [[103, 500, 200]]]
      ]
    }
  });

  assert.equal(result.candles[15].length, 2);
  assert.equal(result.candles[15][1].delta, 300);
  assert.equal(result.candles[15][1].time, 1800000900000);
  assert.deepEqual(result.candles[15][1].levels[0], { price: 103, positiveVolume: 500, negativeVolume: 200 });
});

test('derives FYERS session CVD and 70 percent value area from profile rows', () => {
  const result = mergeFyersOrderflow(null, {
    symbol: 'NSE:NIFTY26OCTFUT',
    endpoint: '/orderflow/volume-profile',
    payload: {
      code: 200,
      data: [
        [100, 80, 20, 100],
        [101, 10, 50, 60],
        [102, 20, 10, 30]
      ]
    }
  });

  assert.equal(result.cvd, 30);
  assert.deepEqual(result.valueArea, { vah: 101, poc: 100, val: 100, totalVolume: 190 });
});

test('preserves prior profile data when a footprint response arrives', () => {
  const previous = { profile: [{ price: 100, volume: 10 }], cvd: -4, valueArea: { vah: 100, poc: 100, val: 100, totalVolume: 10 } };
  const result = mergeFyersOrderflow(previous, {
    symbol: 'NSE:NIFTY26OCTFUT',
    endpoint: '/orderflow/footprint',
    payload: { code: 200, data: [[1800000000, 100, 101, 99, 100, 10, 0, 6, 4, 2, null, null, null, []]] }
  });

  assert.equal(result.profile, previous.profile);
  assert.equal(result.cvd, -4);
});

test('uses the captured timeframe when FYERS returns only one footprint candle', () => {
  const result = mergeFyersOrderflow(null, {
    symbol: 'NSE:NIFTY26OCTFUT',
    endpoint: '/orderflow/footprint',
    timeframe: '5m',
    payload: {
      code: 200,
      data: [[1800000000, 100, 103, 99, 102, 1200, 0, 700, 500, 200, null, null, null, [[101, 300, 100]]]]
    }
  });

  assert.equal(result.candles[5].length, 1);
  assert.equal(result.candles[5][0].levels[0].positiveVolume, 300);
});

test('merges repeated footprint responses instead of discarding earlier candles', () => {
  const first = mergeFyersOrderflow(null, {
    symbol: 'NSE:NIFTY26OCTFUT',
    endpoint: '/orderflow/footprint',
    timeframe: 5,
    payload: {
      code: 200,
      data: [
        [1800000000, 100, 101, 99, 100, 100, 0, 60, 40, 20, null, null, null, [[100, 60, 40]]],
        [1800000300, 100, 102, 99, 101, 120, 0, 80, 40, 40, null, null, null, [[101, 80, 40]]]
      ]
    }
  });
  const second = mergeFyersOrderflow(first, {
    symbol: 'NSE:NIFTY26OCTFUT',
    endpoint: '/orderflow/footprint',
    timeframe: 5,
    payload: {
      code: 200,
      data: [[1800000300, 100, 103, 99, 102, 140, 0, 90, 50, 40, null, null, null, [[102, 90, 50]]]]
    }
  });

  assert.equal(second.candles[5].length, 2);
  assert.equal(second.candles[5][0].cvd, 20);
  assert.equal(second.candles[5][1].close, 102);
  assert.equal(second.candles[5][1].cvd, 60);
});

test('keeps in-memory footprint candles bounded to the latest two India trading dates', () => {
  const timestamps = [
    '2026-10-01T04:00:00.000Z',
    '2026-10-02T04:00:00.000Z',
    '2026-10-05T04:00:00.000Z'
  ];
  const result = mergeFyersOrderflow(null, {
    symbol: 'NSE:NIFTY26OCTFUT',
    endpoint: '/orderflow/footprint',
    timeframe: 5,
    payload: {
      code: 200,
      data: timestamps.map((timestamp, index) => [
        Date.parse(timestamp) / 1000, 100 + index, 101 + index, 99 + index, 100 + index, 10, 0, 6, 4, 2, null, null, null, []
      ])
    }
  });
  const dates = result.candles[5].map((candle) => new Date(candle.time).toISOString().slice(0, 10));

  assert.deepEqual(dates, ['2026-10-02', '2026-10-05']);
});