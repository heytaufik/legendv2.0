import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
    .filter((candle) => candle.time > signal.signalTime
      && (!signal.triggeredAt || candle.time > signal.triggeredAt)
      && candle.time + 5 * 60000 <= now)
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
      signal.demoEntryPrice = signal.entry;
      signal.demoOpenedAt = new Date(candle.time).toISOString();
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

function updateLiveDemoTrade(signal, livePrice, previousPrice, now) {
  if (!Number.isFinite(livePrice) || signal.status === 'RESOLVED') return;

  if (signal.status !== 'ACTIVE') {
    const crossedEntry = Number.isFinite(previousPrice)
      && (signal.direction === 'UP'
        ? previousPrice < signal.entry && livePrice >= signal.entry
        : previousPrice > signal.entry && livePrice <= signal.entry);
    if (!crossedEntry && livePrice !== signal.entry) return;
    signal.status = 'ACTIVE';
    signal.triggeredAt = now;
    signal.demoEntryPrice = signal.entry;
    signal.demoOpenedAt = new Date(now).toISOString();
  }

  const stopHit = signal.direction === 'UP' ? livePrice <= signal.stop : livePrice >= signal.stop;
  const targetHit = signal.direction === 'UP' ? livePrice >= signal.target : livePrice <= signal.target;
  if (stopHit && targetHit) return;
  if (stopHit) closeSignal(signal, 'STOP', { time: now - 5 * 60000, close: livePrice });
  else if (targetHit) closeSignal(signal, 'TARGET', { time: now - 5 * 60000, close: livePrice });
}

export function recordTradeOutcomes(journal = { signals: [] }, {
  instrument,
  analysis,
  sessions = [],
  now = Date.now(),
  livePrice = null,
  previousPrice = null,
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
    if (signal.instrument !== instrument || signal.status === 'RESOLVED') continue;
    advanceSignal(signal, sessions, now);
    updateLiveDemoTrade(signal, livePrice, previousPrice, now);
  }

  return next;
}

export function listOpenDemoTrades(journal = { signals: [] }, instrument, date, currentPrice = null) {
  return (journal?.signals || [])
    .filter((signal) => signal.instrument === instrument && signal.date === date && signal.status !== 'RESOLVED')
    .sort((left, right) => right.signalTime - left.signalTime)
    .slice(0, 10)
    .map((signal) => ({
      id: signal.id,
      direction: signal.direction,
      model: signal.model,
      status: signal.status,
      entry: signal.entry,
      stop: signal.stop,
      target: signal.target,
      evidenceScore: signal.evidenceScore,
      triggeredAt: signal.triggeredAt,
      demoEntryPrice: signal.demoEntryPrice ?? (signal.status === 'ACTIVE' ? signal.entry : null),
      currentPrice,
      unrealizedR: signal.status === 'ACTIVE' && Number.isFinite(currentPrice)
        ? realizedR(signal, currentPrice)
        : null
    }));
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
