import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listOpenDemoTrades, readTradeOutcomes, recordTradeOutcomes, writeTradeOutcomes } from '../lib/trade-outcomes.js';

const signalTime = Date.parse('2026-10-05T09:15:00+05:30');
const instrument = 'NIFTY';

function marketCandle(time, { high, low, close }) {
  return { time, open: 101, high, low, close };
}

function setupSessions(candles) {
  return [{ date: '2026-10-05', candles: { 5: candles } }];
}

function planAnalysis() {
  return {
    latestCandleTime: signalTime,
    tradePlan: {
      direction: 'UP',
      model: 'Stacked imbalance continuation',
      evidenceScore: 80,
      entry: 102,
      stop: 99,
      target: 108,
      risk: 3,
      riskReward: 2
    }
  };
}

test('records a rule-based setup once and tracks trigger then target outcome', () => {
  const signalCandle = marketCandle(signalTime, { high: 102, low: 100, close: 101 });
  let journal = recordTradeOutcomes({ signals: [] }, {
    instrument,
    analysis: planAnalysis(),
    sessions: setupSessions([signalCandle]),
    now: signalTime + 5 * 60000
  });
  assert.equal(journal.signals.length, 1);
  assert.equal(journal.signals[0].status, 'WAITING_FOR_TRIGGER');

  const triggerCandle = marketCandle(signalTime + 5 * 60000, { high: 104, low: 101, close: 103 });
  journal = recordTradeOutcomes(journal, {
    instrument,
    analysis: planAnalysis(),
    sessions: setupSessions([signalCandle, triggerCandle]),
    now: signalTime + 10 * 60000
  });
  assert.equal(journal.signals.length, 1);
  assert.equal(journal.signals[0].status, 'ACTIVE');

  const targetCandle = marketCandle(signalTime + 10 * 60000, { high: 109, low: 103, close: 108 });
  journal = recordTradeOutcomes(journal, {
    instrument,
    analysis: { tradePlan: null },
    sessions: setupSessions([signalCandle, triggerCandle, targetCandle]),
    now: signalTime + 15 * 60000
  });
  assert.equal(journal.signals[0].outcome, 'TARGET');
  assert.equal(journal.signals[0].rMultiple, 2);
});

test('opens a demo trade only when live price crosses its trigger and resolves from live target', () => {
  const setupCandle = marketCandle(signalTime, { high: 101, low: 100, close: 101 });
  let journal = recordTradeOutcomes({ signals: [] }, {
    instrument,
    analysis: planAnalysis(),
    sessions: setupSessions([setupCandle]),
    now: signalTime + 5 * 60000,
    livePrice: 101.9,
    previousPrice: 101.8
  });
  assert.equal(journal.signals[0].status, 'WAITING_FOR_TRIGGER');

  journal = recordTradeOutcomes(journal, {
    instrument,
    analysis: { tradePlan: null },
    sessions: setupSessions([setupCandle]),
    now: signalTime + 6 * 60000,
    livePrice: 102.1,
    previousPrice: 101.9
  });
  assert.equal(journal.signals[0].status, 'ACTIVE');
  assert.equal(journal.signals[0].demoEntryPrice, 102);

  journal = recordTradeOutcomes(journal, {
    instrument,
    analysis: { tradePlan: null },
    sessions: setupSessions([setupCandle]),
    now: signalTime + 7 * 60000,
    livePrice: 108,
    previousPrice: 107.9
  });
  assert.equal(journal.signals[0].status, 'RESOLVED');
  assert.equal(journal.signals[0].outcome, 'TARGET');
});

test('lists saved waiting and active demo setups with live unrealized R', () => {
  const journal = recordTradeOutcomes({ signals: [] }, {
    instrument,
    analysis: planAnalysis(),
    sessions: setupSessions([marketCandle(signalTime, { high: 101, low: 100, close: 101 })]),
    now: signalTime + 5 * 60000
  });
  const waiting = listOpenDemoTrades(journal, instrument, '2026-10-05', 101.5);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].status, 'WAITING_FOR_TRIGGER');
  assert.equal(waiting[0].unrealizedR, null);

  const active = recordTradeOutcomes(journal, {
    instrument,
    analysis: { tradePlan: null },
    sessions: setupSessions([marketCandle(signalTime, { high: 101, low: 100, close: 101 })]),
    now: signalTime + 6 * 60000,
    livePrice: 102,
    previousPrice: 101
  });
  const open = listOpenDemoTrades(active, instrument, '2026-10-05', 105);
  assert.equal(open[0].status, 'ACTIVE');
  assert.equal(open[0].unrealizedR, 1);
});

test('excludes same-bar stop/target ambiguity and signals that expire without a trigger', () => {
  const signal = {
    id: 'nifty:ambiguous',
    instrument,
    date: '2026-10-05',
    signalTime,
    direction: 'UP',
    model: 'Stacked imbalance continuation',
    entry: 102,
    stop: 99,
    target: 108,
    risk: 3,
    riskReward: 2,
    status: 'WAITING_FOR_TRIGGER',
    triggeredAt: null
  };
  const ambiguous = recordTradeOutcomes({ signals: [signal] }, {
    instrument,
    analysis: { tradePlan: null },
    sessions: setupSessions([
      marketCandle(signalTime, { high: 102, low: 100, close: 101 }),
      marketCandle(signalTime + 5 * 60000, { high: 109, low: 98, close: 104 })
    ]),
    now: signalTime + 10 * 60000
  });
  assert.equal(ambiguous.signals[0].outcome, 'AMBIGUOUS');

  const expired = recordTradeOutcomes({ signals: [{ ...signal, id: 'nifty:expired' }] }, {
    instrument,
    analysis: { tradePlan: null },
    sessions: [
      { date: '2026-10-05', candles: { 5: [marketCandle(signalTime, { high: 101, low: 100, close: 101 }), marketCandle(signalTime + 5 * 60000, { high: 101, low: 100, close: 100 })] } },
      { date: '2026-10-06', candles: { 5: [] } }
    ],
    now: signalTime + 24 * 60 * 60000
  });
  assert.equal(expired.signals[0].outcome, 'EXPIRED');
});

test('persists the long-term outcome journal in an atomic JSON file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'legend-outcomes-'));
  const filePath = path.join(directory, 'data', 'outcomes.json');
  const journal = { signals: [{ id: 'sample', outcome: 'TARGET' }] };
  try {
    await writeTradeOutcomes(filePath, journal);
    assert.deepEqual(await readTradeOutcomes(filePath), journal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
