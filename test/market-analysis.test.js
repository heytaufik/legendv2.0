import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarketHistory } from '../lib/market-analysis.js';

const now = Date.parse('2026-10-02T11:00:00+05:30');

function candle(index, { levels = null, delta = 20 } = {}) {
  const time = now - (6 - index) * 5 * 60000;
  const open = 95 + index;
  const close = open + 1;
  return {
    time,
    open,
    high: Math.max(open, close) + (index === 5 ? 1 : 0.2),
    low: Math.min(open, close) - 0.5,
    close,
    volume: 100,
    positiveVolume: 60,
    negativeVolume: 40,
    delta,
    cvd: (index + 1) * delta,
    levels: levels || [{ price: close, positiveVolume: 60, negativeVolume: 40 }]
  };
}

function sessionHistory({ footprint = true } = {}) {
  const candles = Array.from({ length: 6 }, (_, index) => candle(index, {
    levels: footprint && index === 5
      ? [
          { price: 100, positiveVolume: 10, negativeVolume: 0 },
          { price: 101, positiveVolume: 10, negativeVolume: 1 },
          { price: 102, positiveVolume: 10, negativeVolume: 1 }
        ]
      : footprint ? [{ price: 95 + index, positiveVolume: 60, negativeVolume: 40 }] : []
  }));
  candles[5] = { ...candles[5], high: 103, low: 99, close: 102 };
  return [
    {
      date: '2026-10-01',
      open: 98,
      high: 130,
      low: 80,
      close: 100,
      vah: 97,
      poc: 95,
      val: 90,
      price: 100,
      profile: [{ price: 90, volume: 100 }, { price: 95, volume: 500 }, { price: 100, volume: 300 }, { price: 110, volume: 100 }],
      candles: { 5: [] }
    },
    {
      date: '2026-10-02',
      open: 100,
      high: 104,
      low: 94,
      close: 104,
      price: 104,
      vah: 105,
      poc: 100,
      val: 95,
      profile: [{ price: 94, volume: 100 }, { price: 98, volume: 500 }, { price: 102, volume: 300 }, { price: 108, volume: 100 }],
      updatedAt: new Date(now - 30000).toISOString(),
      footprintUpdatedAt: new Date(now - 30000).toISOString(),
      candles: { 5: candles }
    }
  ];
}

test('opening location alone never generates a trade plan without real footprint levels', () => {
  const analysis = analyzeMarketHistory({ sessions: sessionHistory({ footprint: false }), tickSize: 1, now });
  assert.equal(analysis.openingDirection, 'UP');
  assert.equal(analysis.readiness, 'WAITING_FOR_REAL_FOOTPRINT');
  assert.equal(analysis.tradePlan, null);
});

test('finds a contiguous aggressive-buy range and waits for price acceptance', () => {
  const sessions = sessionHistory();
  sessions[1].candles[5].slice(0, -1).forEach((bar) => { bar.levels = []; });
  const analysis = analyzeMarketHistory({ sessions, tickSize: 1, now });
  assert.equal(analysis.trendDirection, 'UP');
  assert.equal(analysis.lastImbalance.direction, 'UP');
  assert.equal(analysis.lastImbalance.buyStack, 3);
  assert.equal(analysis.openingDirection, 'UP');
  assert.deepEqual(
    { low: analysis.deltaArea.low, high: analysis.deltaArea.high, direction: analysis.deltaArea.direction },
    { low: 100, high: 102, direction: 'UP' }
  );
  assert.equal(analysis.deltaArea.accepted, false);
  assert.equal(analysis.tradePlan, null);
  assert.equal(analysis.aggressiveFlow.direction, 'UP');
  assert.ok(analysis.aggressiveAtImportantLevels.some((level) => level.name === 'Session POC' && level.direction === 'UP'));
  assert.match(analysis.reason, /waiting for price acceptance/i);
});

function continuationHistory(direction, accepted) {
  const sessions = sessionHistory();
  const candles = Array.from({ length: 8 }, (_, index) => {
    const open = direction === 'UP' ? 100 + index : 110 - index;
    return {
      ...candle(index),
      time: now - (8 - index) * 5 * 60000,
      open,
      high: direction === 'UP' ? open + 2 : open + 1,
      low: direction === 'UP' ? open - 1 : open - 2,
      close: direction === 'UP' ? open + 1 : open - 1,
      levels: index === 4
        ? direction === 'UP'
          ? [
              { price: 104, positiveVolume: 80, negativeVolume: 10 },
              { price: 105, positiveVolume: 80, negativeVolume: 10 },
              { price: 106, positiveVolume: 80, negativeVolume: 10 }
            ]
          : [
              { price: 104, positiveVolume: 10, negativeVolume: 80 },
              { price: 105, positiveVolume: 10, negativeVolume: 80 },
              { price: 106, positiveVolume: 10, negativeVolume: 80 }
            ]
        : []
    };
  });
  if (!accepted && direction === 'UP') {
    candles[7] = { ...candles[7], low: 104, close: 105 };
  }
  sessions[1].open = direction === 'UP' ? 100 : 110;
  sessions[1].price = direction === 'UP'
    ? accepted ? 109 : 107
    : accepted ? 101 : 103;
  sessions[1].candles[5] = candles;
  return sessions;
}

test('suggests a buy-zone pullback only after price accepts above its delta range', () => {
  const analysis = analyzeMarketHistory({
    sessions: continuationHistory('UP', true),
    tickSize: 1,
    now
  });
  assert.deepEqual([analysis.deltaArea.low, analysis.deltaArea.high], [104, 106]);
  assert.equal(analysis.deltaArea.accepted, true);
  assert.equal(analysis.readiness, 'CONTINUATION_AREA_ACCEPTED');
  assert.equal(analysis.tradePlan, null);
});

test('suggests a sell-zone pullback only after price accepts below its delta range', () => {
  const analysis = analyzeMarketHistory({
    sessions: continuationHistory('DOWN', true),
    tickSize: 1,
    now
  });
  assert.deepEqual([analysis.deltaArea.low, analysis.deltaArea.high], [104, 106]);
  assert.equal(analysis.deltaArea.direction, 'DOWN');
  assert.equal(analysis.deltaArea.accepted, true);
  assert.equal(analysis.tradePlan, null);
});

test('waits for continuation-range acceptance before suggesting an entry', () => {
  const analysis = analyzeMarketHistory({
    sessions: continuationHistory('UP', false),
    tickSize: 1,
    now
  });
  assert.equal(analysis.deltaArea.accepted, false);
  assert.equal(analysis.readiness, 'WAITING_FOR_AREA_ACCEPTANCE');
  assert.match(analysis.reason, /waiting for price acceptance/i);
});

function reversalHistory({ withStackedSellImbalance = false } = {}) {
  const sessions = sessionHistory();
  const candles = Array.from({ length: 8 }, (_, index) => {
    const open = 100 + index;
    return {
      ...candle(index, { delta: index < 6 ? 100 : index === 6 ? 10 : -20 }),
      time: now - (8 - index) * 5 * 60000,
      open,
      high: open + 1,
      low: open - 1,
      close: open + 0.5,
      volume: 1000,
      levels: []
    };
  });
  candles[6] = {
    ...candles[6],
    open: 106,
    high: 107,
    low: 106,
    close: 106.5,
    delta: 10,
    volume: 2600
  };
  candles[7] = {
    ...candles[7],
    open: 106.5,
    high: 106.8,
    low: 105.5,
    close: 106,
    delta: -20,
    volume: withStackedSellImbalance ? 1200 : 1000,
    levels: withStackedSellImbalance
      ? [
          { price: 104, positiveVolume: 1, negativeVolume: 20 },
          { price: 105, positiveVolume: 1, negativeVolume: 20 },
          { price: 106, positiveVolume: 1, negativeVolume: 20 }
        ]
      : []
  };
  sessions[1].open = 100;
  sessions[1].price = candles[7].close;
  sessions[1].candles[5] = candles;
  return sessions;
}

test('signals reversal from divergence, absorption, and exhaustion without requiring stacked imbalance', () => {
  const analysis = analyzeMarketHistory({ sessions: reversalHistory(), tickSize: 1, now });
  const setup = analysis.reversalSetup;
  assert.equal(setup.direction, 'DOWN');
  assert.equal(setup.status, 'SIGNAL');
  assert.equal(setup.conditionsMet, 3);
  assert.equal(setup.deltaDivergence, true);
  assert.equal(setup.absorption, true);
  assert.equal(setup.exhaustion, true);
  assert.equal(setup.stackedImbalance, false);
  assert.equal(setup.entryTrigger, 104.5);
  assert.equal(analysis.tradePlan, null);
});

test('uses stacked sell imbalance as optional reversal confirmation', () => {
  const analysis = analyzeMarketHistory({
    sessions: reversalHistory({ withStackedSellImbalance: true }),
    tickSize: 1,
    now
  });
  assert.equal(analysis.reversalSetup.status, 'SIGNAL');
  assert.equal(analysis.reversalSetup.stackedImbalance, true);
});

test('measures buy and sell volume areas across every completed session candle', () => {
  const sessions = sessionHistory();
  const candles = sessions[1].candles[5];
  candles.unshift({
    ...candles[0],
    time: now - 8 * 5 * 60000,
    delta: 10,
    levels: [{ price: 97, positiveVolume: 250, negativeVolume: 0 }]
  });
  candles[1] = {
    ...candles[1],
    levels: [{ price: 97, positiveVolume: 250, negativeVolume: 0 }]
  };
  candles.at(-1).levels = [{ price: 102, positiveVolume: 3, negativeVolume: 600 }];

  const analysis = analyzeMarketHistory({ sessions, tickSize: 1, now });

  assert.equal(analysis.completedCandleCount, 7);
  assert.equal(analysis.sessionDelta, 130);
  assert.deepEqual(analysis.buyingArea, { price: 97, buyerVolume: 560, sellerVolume: 40 });
  assert.deepEqual(analysis.sellingArea, { price: 102, buyerVolume: 3, sellerVolume: 600 });
});

test('does not offer a plan from stale captures', () => {
  const sessions = sessionHistory();
  sessions[1].updatedAt = new Date(now - 3 * 60000).toISOString();
  const analysis = analyzeMarketHistory({ sessions, tickSize: 1, now });

  assert.equal(analysis.marketDataFresh, false);
  assert.equal(analysis.readiness, 'WAITING_FOR_FRESH_MARKET_DATA');
  assert.equal(analysis.tradePlan, null);
});

test('does not treat live ticks as proof that the 5-minute footprint is fresh', () => {
  const sessions = sessionHistory();
  sessions[1].updatedAt = new Date(now - 1000).toISOString();
  sessions[1].footprintUpdatedAt = new Date(now - 3 * 60000).toISOString();
  const analysis = analyzeMarketHistory({ sessions, tickSize: 1, now });

  assert.equal(analysis.marketDataFresh, true);
  assert.equal(analysis.footprintDataFresh, false);
  assert.equal(analysis.readiness, 'WAITING_FOR_FRESH_FOOTPRINT_DATA');
  assert.equal(analysis.tradePlan, null);
});

test('uses the latest earlier session with a valid value area', () => {
  const sessions = sessionHistory();
  sessions[0].vah = null;
  sessions[0].val = null;
  sessions.unshift({
    date: '2026-09-30',
    vah: 97,
    poc: 95,
    val: 90,
    profile: [{ price: 90, volume: 100 }, { price: 95, volume: 500 }, { price: 100, volume: 300 }],
    candles: { 5: [] }
  });

  const analysis = analyzeMarketHistory({ sessions, tickSize: 1, now });
  assert.equal(analysis.previousDate, '2026-09-30');
});

test('never evaluates a new entry while the market is closed', () => {
  const analysis = analyzeMarketHistory({ sessions: sessionHistory(), tickSize: 1, now, marketDay: false });

  assert.equal(analysis.readiness, 'MARKET_CLOSED');
  assert.equal(analysis.tradePlan, null);
});
