import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { indiaDateKey } from './session-profile.js';

export const ORDERFLOW_RETENTION_SESSIONS = 2;

export function mergeOrderflowHistory(history, { date, instrument, orderflow }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof instrument !== 'string' || !instrument) {
    throw new TypeError('A valid session date and instrument are required');
  }

  const next = structuredClone(history || {});
  for (const [timeframe, incoming] of Object.entries(orderflow.candles || {})) {
    incoming.forEach((candle) => {
      const candleDate = indiaDateKey(new Date(candle.time));
      const session = next[candleDate] || {};
      const previous = session[instrument] || {};
      const candles = { ...(previous.candles || {}) };
      const byTime = new Map((candles[timeframe] || []).map((item) => [item.time, item]));
      const previousCandle = byTime.get(candle.time);
      byTime.set(candle.time, {
        ...candle,
        levels: candle.levels?.length ? candle.levels : previousCandle?.levels || []
      });
      candles[timeframe] = [...byTime.values()].sort((left, right) => left.time - right.time);
      session[instrument] = { ...previous, symbol: orderflow.symbol, candles, updatedAt: orderflow.updatedAt };
      next[candleDate] = session;
    });
  }

  const session = next[date] || {};
  const previous = session[instrument] || {};
  session[instrument] = {
    ...previous,
    symbol: orderflow.symbol,
    candles: { ...(previous.candles || {}) },
    candleUpdatedAt: { ...(previous.candleUpdatedAt || {}), ...(orderflow.candleUpdatedAt || {}) },
    footprintUpdatedAt: orderflow.footprintUpdatedAt || previous.footprintUpdatedAt || null,
    profileUpdatedAt: orderflow.profileUpdatedAt || previous.profileUpdatedAt || null,
    profile: orderflow.profile?.length ? orderflow.profile : previous.profile || [],
    valueArea: orderflow.profile?.length ? orderflow.valueArea : previous.valueArea || null,
    cvd: orderflow.profile?.length ? orderflow.cvd : previous.cvd ?? null,
    updatedAt: orderflow.updatedAt
  };
  next[date] = session;

  const retainedDates = Object.keys(next).filter((key) => key <= date).sort().slice(-ORDERFLOW_RETENTION_SESSIONS);
  return Object.fromEntries(retainedDates.map((key) => [key, next[key]]));
}

export async function readOrderflowHistory(filePath, asOfDate) {
  try {
    const history = JSON.parse(await readFile(filePath, 'utf8'));
    if (!history || typeof history !== 'object' || Array.isArray(history)) return {};
    const dates = Object.keys(history).filter((date) => date <= asOfDate).sort().slice(-ORDERFLOW_RETENTION_SESSIONS);
    return Object.fromEntries(dates.map((date) => [date, history[date]]));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeOrderflowHistory(filePath, history) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(history), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}
