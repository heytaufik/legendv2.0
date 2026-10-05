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

test('combines price structure, delta, location, stacked footprint and opening context', () => {
  const analysis = analyzeMarketHistory({ sessions: sessionHistory(), tickSize: 1, now });
  assert.equal(analysis.trendDirection, 'UP');
  assert.equal(analysis.lastImbalance.direction, 'UP');
  assert.equal(analysis.lastImbalance.buyStack, 3);
  assert.equal(analysis.openingDirection, 'UP');
  assert.ok(['Stacked imbalance continuation', 'Current POC pullback'].includes(analysis.tradePlan?.model));
  assert.equal(analysis.tradePlan?.evidenceScore, 100);
  assert.ok(analysis.tradePlan.riskReward >= 1);
  assert.equal(analysis.tradePlan.status, 'TRIGGER_NEAR');
  assert.equal(analysis.tradePlan.evidence.reduce((total, factor) => total + factor.points, 0), 100);
  assert.equal(analysis.aggressiveFlow.direction, 'UP');
  assert.ok(analysis.aggressiveAtImportantLevels.some((level) => level.name === 'Session POC' && level.direction === 'UP'));
  assert.ok(analysis.confluences.some((factor) => factor.name === 'aggressive bid/ask volume agrees' && factor.present));
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
