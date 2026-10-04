import { calculateValueArea, indiaDateKey } from './session-profile.js';

const timeframes = [1, 3, 5, 15, 30, 60];

function dataRows(response, minimumLength) {
  if (response?.code !== 200 || !Array.isArray(response.data)) {
    throw new TypeError('Invalid FYERS order-flow response');
  }
  return response.data.filter((row) => Array.isArray(row) && row.length >= minimumLength);
}

function inferTimeframe(rows, requestedTimeframe) {
  const match = /^(\d+)\s*m?$/i.exec(String(requestedTimeframe ?? '').trim());
  const requested = match ? Number(match[1]) : NaN;
  if (timeframes.includes(requested)) return requested;

  const counts = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    const minutes = Math.round((Number(rows[index][0]) - Number(rows[index - 1][0])) / 60);
    if (timeframes.includes(minutes)) counts.set(minutes, (counts.get(minutes) || 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] || null;
}

function normalizeFootprint(response, requestedTimeframe) {
  const rows = dataRows(response, 14);
  const timeframe = inferTimeframe(rows, requestedTimeframe);
  let sessionDate = null;
  let cvd = 0;
  const candles = rows.map((row) => {
    const time = Number(row[0]) * 1000;
    const date = indiaDateKey(new Date(time));
    if (date !== sessionDate) {
      sessionDate = date;
      cvd = 0;
    }
    cvd += Number(row[9]);
    return {
      time,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      positiveVolume: Number(row[7]),
      negativeVolume: Number(row[8]),
      delta: Number(row[9]),
      cvd,
      levels: Array.isArray(row[13])
        ? row[13].filter((level) => Array.isArray(level) && level.length >= 3)
          .map(([price, positiveVolume, negativeVolume]) => ({
            price: Number(price),
            positiveVolume: Number(positiveVolume),
            negativeVolume: Number(negativeVolume)
          })).filter((level) => [level.price, level.positiveVolume, level.negativeVolume].every(Number.isFinite))
        : []
    };
  }).filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.delta, candle.cvd].every(Number.isFinite));

  return { timeframe, candles };
}

function normalizeVolumeProfile(response) {
  const rows = dataRows(response, 4);
  const profile = rows.map(([price, positiveVolume, negativeVolume, volume]) => ({
    price: Number(price),
    positiveVolume: Number(positiveVolume),
    negativeVolume: Number(negativeVolume),
    volume: Number(volume)
  })).filter((level) => [level.price, level.positiveVolume, level.negativeVolume, level.volume].every(Number.isFinite) && level.volume > 0);
  const valueArea = calculateValueArea(profile.map((level) => [level.price, level.volume]));
  const positiveVolume = profile.reduce((total, level) => total + level.positiveVolume, 0);
  const negativeVolume = profile.reduce((total, level) => total + level.negativeVolume, 0);

  return { profile, valueArea, cvd: positiveVolume - negativeVolume };
}

export function mergeFyersOrderflow(previous, { symbol, endpoint, payload, timeframe }) {
  if (typeof symbol !== 'string' || !symbol || !symbol.includes(':')) {
    throw new TypeError('FYERS symbol is required');
  }
  const next = {
    symbol,
    updatedAt: new Date().toISOString(),
    footprintUpdatedAt: previous?.footprintUpdatedAt || null,
    profileUpdatedAt: previous?.profileUpdatedAt || null,
    candles: { ...(previous?.candles || {}) },
    candleUpdatedAt: { ...(previous?.candleUpdatedAt || {}) },
    profile: previous?.profile || [],
    valueArea: previous?.valueArea || { vah: null, poc: null, val: null, totalVolume: 0 },
    cvd: previous?.cvd ?? null
  };

  if (endpoint === '/orderflow/footprint') {
    const footprint = normalizeFootprint(payload, timeframe);
    if (footprint.timeframe) {
      const byTime = new Map((next.candles[footprint.timeframe] || []).map((candle) => [candle.time, candle]));
      footprint.candles.forEach((candle) => {
        const previousCandle = byTime.get(candle.time);
        byTime.set(candle.time, {
          ...candle,
          levels: candle.levels.length ? candle.levels : previousCandle?.levels || []
        });
      });
      const sortedCandles = [...byTime.values()].sort((left, right) => left.time - right.time);
      const retainedDates = [...new Set(sortedCandles.map((candle) => indiaDateKey(new Date(candle.time))))]
        .sort()
        .slice(-2);
      const retainedDateSet = new Set(retainedDates);
      let sessionDate = null;
      let cvd = 0;
      next.candles[footprint.timeframe] = sortedCandles
        .filter((candle) => retainedDateSet.has(indiaDateKey(new Date(candle.time))))
        .map((candle) => {
          const date = indiaDateKey(new Date(candle.time));
          if (date !== sessionDate) {
            sessionDate = date;
            cvd = 0;
          }
          cvd += candle.delta;
          return { ...candle, cvd };
        });
      next.candleUpdatedAt[footprint.timeframe] = next.updatedAt;
    }
    next.footprintUpdatedAt = next.updatedAt;
  } else if (endpoint === '/orderflow/volume-profile') {
    Object.assign(next, normalizeVolumeProfile(payload));
    next.profileUpdatedAt = next.updatedAt;
  } else {
    throw new TypeError('Unsupported FYERS order-flow endpoint');
  }

  return next;
}