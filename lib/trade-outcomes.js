import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MIN_CALIBRATION_SAMPLE = 30;

function evidenceBand(score) {
  if (!Number.isFinite(score)) return 'UNKNOWN';
  const lower = Math.floor(score / 10) * 10;
  return `${lower}-${lower + 9}`;
}

function sessionCandles(sessions, date) {
  return sessions.find((session) => session.date === date)?.candles?.['5']
    || sessions.find((session) => session.date === date)?.candles?.[5]
    || [];
}

function realizedR(signal, close) {
  return signal.direction === 'UP'
    ? (close - signal.entry) / signal.risk
    : (signal.entry - close) / signal.risk;
}

function closeSignal(signal, outcome, candle, rMultiple = null) {
  signal.status = 'RESOLVED';
  signal.outcome = outcome;
  signal.outcomeAt = candle.time + 5 * 60000;
  signal.outcomePrice = outcome === 'TARGET' ? signal.target
    : outcome === 'STOP' ? signal.stop
      : candle.close;
  signal.rMultiple = rMultiple ?? (outcome === 'TARGET' ? signal.riskReward
    : outcome === 'STOP' ? -1
      : realizedR(signal, candle.close));
}

function advanceSignal(signal, sessions, now) {
  const candles = sessionCandles(sessions, signal.date)
    .filter((candle) => candle.time > signal.signalTime && candle.time + 5 * 60000 <= now)
    .sort((left, right) => left.time - right.time);

  for (const candle of candles) {
    const triggerHit = signal.direction === 'UP' ? candle.high >= signal.entry : candle.low <= signal.entry;
    if (!signal.triggeredAt && !triggerHit) continue;

    const stopHit = signal.direction === 'UP' ? candle.low <= signal.stop : candle.high >= signal.stop;
    const targetHit = signal.direction === 'UP' ? candle.high >= signal.target : candle.low <= signal.target;
    if (stopHit && targetHit) {
      signal.status = 'RESOLVED';
      signal.outcome = 'AMBIGUOUS';
      signal.outcomeAt = candle.time + 5 * 60000;
      signal.outcomePrice = null;
      signal.rMultiple = null;
      return;
    }
    if (!signal.triggeredAt) {
      signal.triggeredAt = candle.time;
      signal.status = 'ACTIVE';
    }
    if (stopHit) {
      closeSignal(signal, 'STOP', candle);
      return;
    }
    if (targetHit) {
      closeSignal(signal, 'TARGET', candle);
      return;
    }
  }

  const laterDates = sessions.filter((session) => session.date > signal.date).sort((left, right) => left.date.localeCompare(right.date));
  if (!laterDates.length) return;
  const finalCandle = [...sessionCandles(sessions, signal.date)]
    .filter((candle) => candle.time + 5 * 60000 <= now)
    .sort((left, right) => left.time - right.time)
    .at(-1);
  if (!finalCandle) {
    signal.status = 'RESOLVED';
    signal.outcome = 'DATA_GAP';
    signal.outcomeAt = now;
    signal.outcomePrice = null;
    signal.rMultiple = null;
    return;
  }
  if (!signal.triggeredAt) {
    signal.status = 'RESOLVED';
    signal.outcome = 'EXPIRED';
    signal.outcomeAt = finalCandle.time + 5 * 60000;
    signal.outcomePrice = finalCandle.close;
    signal.rMultiple = null;
    return;
  }
  const r = realizedR(signal, finalCandle.close);
  closeSignal(signal, r > 0 ? 'SESSION_CLOSE_WIN' : r < 0 ? 'SESSION_CLOSE_LOSS' : 'SESSION_CLOSE_FLAT', finalCandle, r);
}

export function recordTradeOutcomes(journal = { signals: [] }, {
  instrument,
  analysis,
  sessions = [],
  now = Date.now(),
  allowNewSignals = true
}) {
  const next = structuredClone(journal || { signals: [] });
  if (!Array.isArray(next.signals)) next.signals = [];
  const currentSession = [...sessions].sort((left, right) => left.date.localeCompare(right.date)).at(-1);

  if (allowNewSignals && analysis?.tradePlan && analysis.latestCandleTime && currentSession?.date) {
    const plan = analysis.tradePlan;
    const id = `${instrument}:${currentSession.date}:${analysis.latestCandleTime}:${plan.direction}:${plan.model}`;
    if (!next.signals.some((signal) => signal.id === id)) {
      next.signals.push({
        id,
        instrument,
        date: currentSession.date,
        signalTime: analysis.latestCandleTime,
        model: plan.model,
        direction: plan.direction,
        evidenceScore: plan.evidenceScore,
        evidenceBand: evidenceBand(plan.evidenceScore),
        evidence: plan.evidence,
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        risk: plan.risk,
        riskReward: plan.riskReward,
        status: 'WAITING_FOR_TRIGGER',
        triggeredAt: null,
        outcome: null,
        createdAt: new Date(now).toISOString()
      });
    }
  }

  for (const signal of next.signals) {
    if (signal.instrument === instrument && signal.status !== 'RESOLVED') advanceSignal(signal, sessions, now);
  }

  return next;
}

function wilsonInterval(wins, sample) {
  const z = 1.959963984540054;
  const rate = wins / sample;
  const denominator = 1 + z * z / sample;
  const center = (rate + z * z / (2 * sample)) / denominator;
  const margin = z * Math.sqrt((rate * (1 - rate) + z * z / (4 * sample)) / sample) / denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin)
  };
}

export function summarizeTradeOutcomes(journal = { signals: [] }, instrument, minimumSample = MIN_CALIBRATION_SAMPLE) {
  const signals = (journal?.signals || []).filter((signal) => signal.instrument === instrument);
  const groups = new Map();
  for (const signal of signals) {
    const scoreBand = signal.evidenceBand || evidenceBand(signal.evidenceScore);
    const key = `${signal.direction}:${signal.model}:${scoreBand}`;
    const group = groups.get(key) || {
      direction: signal.direction,
      model: signal.model,
      evidenceBand: scoreBand,
      totalSignals: 0,
      waiting: 0,
      active: 0,
      expired: 0,
      ambiguous: 0,
      wins: 0,
      losses: 0,
      flat: 0,
      rTotal: 0
    };
    group.totalSignals += 1;
    if (signal.status !== 'RESOLVED') {
      if (signal.status === 'ACTIVE') group.active += 1;
      else group.waiting += 1;
    } else if (signal.outcome === 'EXPIRED') group.expired += 1;
    else if (signal.outcome === 'AMBIGUOUS') group.ambiguous += 1;
    else if (signal.outcome === 'DATA_GAP') group.dataGaps = (group.dataGaps || 0) + 1;
    else if (signal.outcome === 'TARGET' || signal.outcome === 'SESSION_CLOSE_WIN') {
      group.wins += 1;
      group.rTotal += signal.rMultiple || 0;
    } else if (signal.outcome === 'STOP' || signal.outcome === 'SESSION_CLOSE_LOSS') {
      group.losses += 1;
      group.rTotal += signal.rMultiple || 0;
    } else if (signal.outcome === 'SESSION_CLOSE_FLAT') {
      group.flat += 1;
    }
    groups.set(key, group);
  }

  const models = [...groups.values()].map((group) => {
    const sample = group.wins + group.losses;
    const interval = sample ? wilsonInterval(group.wins, sample) : null;
    return {
      ...group,
      resolvedSample: sample,
      probabilityAvailable: sample >= minimumSample,
      historicalPositiveRate: sample >= minimumSample ? group.wins / sample : null,
      confidenceInterval95: sample >= minimumSample ? interval : null,
      averageR: sample ? group.rTotal / sample : null
    };
  }).sort((left, right) => right.resolvedSample - left.resolvedSample || left.model.localeCompare(right.model));
  const resolvedSample = models.reduce((total, model) => total + model.resolvedSample, 0);

  return {
    kind: 'RULE_BASED_SIMULATED_OUTCOMES',
    minimumSample,
    resolvedSample,
    totalSignals: models.reduce((total, model) => total + model.totalSignals, 0),
    pendingSignals: models.reduce((total, model) => total + model.waiting + model.active, 0),
    excludedNoTrigger: models.reduce((total, model) => total + model.expired, 0),
    excludedAmbiguous: models.reduce((total, model) => total + model.ambiguous, 0),
    excludedDataGaps: models.reduce((total, model) => total + (model.dataGaps || 0), 0),
    probabilityAvailable: false,
    historicalPositiveRate: null,
    confidenceInterval95: null,
    models
  };
}

export async function readTradeOutcomes(filePath) {
  try {
    const journal = JSON.parse(await readFile(filePath, 'utf8'));
    if (!journal || typeof journal !== 'object' || Array.isArray(journal) || !Array.isArray(journal.signals)) return { signals: [] };
    return journal;
  } catch (error) {
    if (error.code === 'ENOENT') return { signals: [] };
    throw error;
  }
}

export async function writeTradeOutcomes(filePath, journal) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(journal), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}
