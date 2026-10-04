import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTradeOutcomes, recordTradeOutcomes, summarizeTradeOutcomes, writeTradeOutcomes } from '../lib/trade-outcomes.js';

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

test('exposes empirical probability only after 30 resolved outcomes for the same model', () => {
  const signals = Array.from({ length: 30 }, (_, index) => ({
    instrument,
    direction: 'UP',
    model: 'Stacked imbalance continuation',
    status: 'RESOLVED',
    outcome: index < 21 ? 'TARGET' : 'STOP',
    rMultiple: index < 21 ? 2 : -1
  }));
  const outcomes = summarizeTradeOutcomes({ signals }, instrument);
  const model = outcomes.models[0];

  assert.equal(outcomes.probabilityAvailable, false);
  assert.equal(model.probabilityAvailable, true);
  assert.equal(model.historicalPositiveRate, 0.7);
  assert.ok(model.confidenceInterval95.lower < model.historicalPositiveRate);
  assert.ok(model.confidenceInterval95.upper > model.historicalPositiveRate);
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
