import { buildProfileBins, detectLowVolumeZones } from './session-profile.js';

function validNumber(value) {
  return Number.isFinite(value);
}

function levelsFromProfile(profile = []) {
  return profile
    .map((level) => Array.isArray(level)
      ? { price: Number(level[0]), volume: Number(level[1]) }
      : { price: Number(level.price), volume: Number(level.volume) })
    .filter((level) => validNumber(level.price) && validNumber(level.volume) && level.volume > 0)
    .sort((left, right) => left.price - right.price);
}

function maxConsecutive(ids) {
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  let maximum = 0;
  let current = 0;
  let previous = null;
  for (const id of sorted) {
    current = previous !== null && id === previous + 1 ? current + 1 : 1;
    maximum = Math.max(maximum, current);
    previous = id;
  }
  return maximum;
}

function candleImbalances(candle, tickSize) {
  const byTick = new Map();
  let buyerVolume = 0;
  let sellerVolume = 0;
  for (const level of candle.levels || []) {
    const tick = Math.round(level.price / tickSize);
    const current = byTick.get(tick) || { ask: 0, bid: 0 };
    current.ask += level.positiveVolume;
    current.bid += level.negativeVolume;
    byTick.set(tick, current);
    buyerVolume += level.positiveVolume;
    sellerVolume += level.negativeVolume;
  }

  const buyImbalanceTicks = [];
  const sellImbalanceTicks = [];
  for (const [tick, volume] of byTick) {
    const lowerBid = byTick.get(tick - 1)?.bid || 0;
    const upperAsk = byTick.get(tick + 1)?.ask || 0;
    if (volume.ask > 0 && volume.ask >= 3 * lowerBid) buyImbalanceTicks.push(tick);
    if (volume.bid > 0 && volume.bid >= 3 * upperAsk) sellImbalanceTicks.push(tick);
  }
  const buyStack = maxConsecutive(buyImbalanceTicks);
  const sellStack = maxConsecutive(sellImbalanceTicks);
  return {
    buyImbalanceCount: buyImbalanceTicks.length,
    sellImbalanceCount: sellImbalanceTicks.length,
    buyStack,
    sellStack,
    buyerVolume,
    sellerVolume,
    aggressiveDirection: buyerVolume > sellerVolume * 1.25 ? 'UP'
      : sellerVolume > buyerVolume * 1.25 ? 'DOWN' : 'MIXED',
    direction: buyStack >= 3 && buyStack > sellStack ? 'UP'
      : sellStack >= 3 && sellStack > buyStack ? 'DOWN'
        : 'NONE'
  };
}

function sessionFootprint(candles, tickSize) {
  const byTick = new Map();
  for (const candle of candles) {
    for (const level of candle.levels || []) {
      const tick = Math.round(level.price / tickSize);
      const aggregate = byTick.get(tick) || { positiveVolume: 0, negativeVolume: 0 };
      aggregate.positiveVolume += level.positiveVolume;
      aggregate.negativeVolume += level.negativeVolume;
      byTick.set(tick, aggregate);
    }
  }

  const levels = [...byTick.entries()].map(([tick, volume]) => ({
    price: Number((tick * tickSize).toFixed(8)),
    ...volume
  }));
  const totalVolume = levels.reduce((total, level) => ({
    positiveVolume: total.positiveVolume + level.positiveVolume,
    negativeVolume: total.negativeVolume + level.negativeVolume
  }), { positiveVolume: 0, negativeVolume: 0 });
  const highestVolumeArea = (volumeKey) => {
    const level = levels.reduce((highest, current) => !highest || current[volumeKey] > highest[volumeKey] ? current : highest, null);
    return level ? {
      price: level.price,
      buyerVolume: level.positiveVolume,
      sellerVolume: level.negativeVolume
    } : null;
  };

  return {
    ...totalVolume,
    imbalance: candleImbalances({ levels }, tickSize),
    buyingArea: highestVolumeArea('positiveVolume'),
    sellingArea: highestVolumeArea('negativeVolume')
  };
}

function deltaEntryArea(candles, direction, currentPrice, tickSize) {
  if (!['UP', 'DOWN'].includes(direction)) return null;

  const byTick = new Map();
  const averageCandleVolume = candles.length
    ? candles.reduce((total, candle) => total + (candle.volume || 0), 0) / candles.length
    : 0;
  for (const candle of candles) {
    for (const level of candle.levels || []) {
      const tick = Math.round(level.price / tickSize);
      const current = byTick.get(tick) || { price: tick * tickSize, buying: 0, selling: 0 };
      current.buying += level.positiveVolume;
      current.selling += level.negativeVolume;
      byTick.set(tick, current);
    }
  }

  const levels = [...byTick.values()].map((level) => {
    const delta = level.buying - level.selling;
    return { ...level, delta, volume: level.buying + level.selling };
  });
  const strongestDelta = Math.max(0, ...levels.map((level) => Math.abs(level.delta)));
  const minimumVolume = Math.max(1, averageCandleVolume * 0.03);
  const minimumDelta = Math.max(1, strongestDelta * 0.2);
  const candidates = levels.filter((level) => level.volume >= minimumVolume
    && Math.abs(level.delta) >= minimumDelta
    && (direction === 'UP'
      ? level.delta > 0 && level.buying >= level.selling * 1.5
      : level.delta < 0 && level.selling >= level.buying * 1.5))
    .sort((left, right) => left.price - right.price);

  const ranges = [];
  for (const level of candidates) {
    const previous = ranges.at(-1);
    if (previous && Math.abs(level.price - previous.high - tickSize) < tickSize * 0.01) {
      previous.high = level.price;
      previous.buying += level.buying;
      previous.selling += level.selling;
      previous.netDelta += level.delta;
      previous.levelCount += 1;
    } else {
      ranges.push({
        low: level.price,
        high: level.price,
        buying: level.buying,
        selling: level.selling,
        netDelta: level.delta,
        levelCount: 1
      });
    }
  }
  const selected = ranges
    .filter((range) => direction === 'UP' ? range.netDelta > 0 : range.netDelta < 0)
    .sort((left, right) => Math.abs(right.netDelta) - Math.abs(left.netDelta))[0];
  if (!selected) return null;

  const latestCandles = candles.slice(-2);
  const accepted = direction === 'UP'
    ? currentPrice > selected.high && latestCandles.length === 2 && latestCandles.every((candle) => candle.close > selected.high)
    : currentPrice < selected.low && latestCandles.length === 2 && latestCandles.every((candle) => candle.close < selected.low);
  return {
    direction,
    low: selected.low,
    high: selected.high,
    buying: selected.buying,
    selling: selected.selling,
    netDelta: selected.netDelta,
    levelCount: selected.levelCount,
    accepted
  };
}

function analyzeReversalSetup(candles, trendDirection, tickSize) {
  const direction = trendDirection === 'UP' ? 'DOWN' : trendDirection === 'DOWN' ? 'UP' : null;
  if (!direction || candles.length < 6) return null;

  const pushIndex = candles.length - 2;
  const push = candles[pushIndex];
  const followThrough = candles.at(-1);
  const baseline = candles.slice(0, pushIndex);
  const priorPush = candles.slice(Math.max(0, pushIndex - 3), pushIndex);
  if (baseline.length < 3 || priorPush.length < 2) return null;

  const trendSign = trendDirection === 'UP' ? 1 : -1;
  const priorMove = (priorPush.at(-1).close - priorPush[0].open) * trendSign;
  const pushMove = (push.close - push.open) * trendSign;
  const priorDelta = priorPush.reduce((total, candle) => total + candle.delta * trendSign, 0);
  const pushDelta = push.delta * trendSign;
  const priorDeltaPerTenPoints = priorMove > tickSize ? priorDelta * 10 / priorMove : 0;
  const pushDeltaPerTenPoints = pushMove > tickSize ? pushDelta * 10 / pushMove : 0;
  const deltaRatio = priorDeltaPerTenPoints > 0
    ? Math.max(0, pushDeltaPerTenPoints) / priorDeltaPerTenPoints
    : null;
  const deltaDivergence = deltaRatio !== null && deltaRatio <= 0.3;

  const averageVolume = baseline.reduce((total, candle) => total + candle.volume, 0) / baseline.length;
  const averageRange = baseline.reduce((total, candle) => total + candle.high - candle.low, 0) / baseline.length;
  const priorExtremes = candles.slice(Math.max(0, pushIndex - 5), pushIndex);
  const atTrendExtreme = trendDirection === 'UP'
    ? push.high >= Math.max(...priorExtremes.map((candle) => candle.high))
    : push.low <= Math.min(...priorExtremes.map((candle) => candle.low));
  const absorption = averageVolume > 0
    && push.volume >= averageVolume * 2.5
    && push.high - push.low <= Math.max(tickSize * 4, averageRange * 0.5)
    && atTrendExtreme;
  const exhaustion = averageVolume > 0
    && push.volume >= averageVolume * 2
    && followThrough.volume < push.volume * 0.5;
  const pushImbalance = candleImbalances(push, tickSize);
  const followImbalance = candleImbalances(followThrough, tickSize);
  const stackedImbalance = direction === 'UP'
    ? pushImbalance.buyStack >= 3 || followImbalance.buyStack >= 3
    : pushImbalance.sellStack >= 3 || followImbalance.sellStack >= 3;
  const conditionsMet = [deltaDivergence, absorption, exhaustion].filter(Boolean).length;
  return {
    direction,
    status: conditionsMet === 3 ? 'SIGNAL' : conditionsMet ? 'WATCH' : 'NONE',
    conditionsMet,
    deltaDivergence,
    deltaRatio,
    absorption,
    absorptionRange: { low: push.low, high: push.high },
    absorptionVolumeMultiple: averageVolume > 0 ? push.volume / averageVolume : null,
    exhaustion,
    followThroughVolumeRatio: push.volume > 0 ? followThrough.volume / push.volume : null,
    stackedImbalance,
    entryTrigger: conditionsMet === 3
      ? direction === 'UP' ? followThrough.high + tickSize : followThrough.low - tickSize
      : null
  };
}

function aggressionAtLevel(candle, price, tickSize) {
  const levels = (candle?.levels || []).filter((level) => Math.abs(level.price - price) <= 2 * tickSize);
  const buyerVolume = levels.reduce((total, level) => total + level.positiveVolume, 0);
  const sellerVolume = levels.reduce((total, level) => total + level.negativeVolume, 0);
  return {
    buyerVolume,
    sellerVolume,
    direction: buyerVolume > sellerVolume * 1.25 ? 'UP'
      : sellerVolume > buyerVolume * 1.25 ? 'DOWN' : 'MIXED'
  };
}

function localProfileLevels(session, tickSize) {
  const levels = levelsFromProfile(session?.profile);
  if (levels.length < 3) return { hvns: [], lvns: [] };
  const bins = buildProfileBins(levels.map(({ price, volume }) => [price, volume]), tickSize);
  const hvns = bins.filter((level, index) => {
    if (index === 0 || index === bins.length - 1 || level.volume <= 0) return false;
    const neighborVolume = Math.max(bins[index - 1].volume, bins[index + 1].volume);
    return level.volume >= neighborVolume * 1.5
      && level.volume > bins[index - 1].volume
      && level.volume > bins[index + 1].volume;
  }).sort((left, right) => right.volume - left.volume)
    .slice(0, 6)
    .map((level) => level.price + (level.high - level.price) / 2);
  const valueArea = { vah: session.vah, val: session.val };
  const lvns = detectLowVolumeZones(bins, valueArea).map((zone) => zone.center);
  return { hvns, lvns };
}

function marketLevels(sessions, tickSize) {
  const points = [];
  for (const session of sessions) {
    for (const key of ['vah', 'poc', 'val', 'high', 'low']) {
      if (validNumber(session[key])) points.push(session[key]);
    }
    const profileLevels = localProfileLevels(session, tickSize);
    points.push(...profileLevels.hvns, ...profileLevels.lvns);
  }
  return [...new Set(points.map((price) => Number(price.toFixed(8))))].sort((left, right) => left - right);
}

function nearestTarget(levels, entry, direction, minimumDistance) {
  const candidates = levels.filter((level) => direction === 'UP'
    ? level >= entry + minimumDistance
    : level <= entry - minimumDistance);
  return direction === 'UP' ? candidates[0] ?? null : candidates.at(-1) ?? null;
}

function scoreSetup({ direction, trendDirection, setupType, delta, locationConfirmed, imbalanceDirection, aggressiveDirection, openingDirection }) {
  const structurePoints = trendDirection === direction ? 20
    : setupType === 'REVERSAL' && delta * (direction === 'UP' ? 1 : -1) > 0
      && (imbalanceDirection === direction || aggressiveDirection === direction) ? 15 : 0;
  const factors = [
    { name: '5-minute structure / reversal response agrees', points: structurePoints, maxPoints: 20 },
    { name: 'recent footprint delta agrees', points: delta * (direction === 'UP' ? 1 : -1) > 0 ? 20 : 0, maxPoints: 20 },
    { name: 'price is reacting at a relevant level', points: locationConfirmed ? 25 : 0, maxPoints: 25 },
    { name: 'stacked diagonal imbalance agrees', points: imbalanceDirection === direction ? 20 : 0, maxPoints: 20 },
    { name: 'aggressive bid/ask volume agrees', points: aggressiveDirection === direction ? 10 : 0, maxPoints: 10 },
    { name: 'opening context agrees (supporting clue only)', points: openingDirection === direction ? 5 : 0, maxPoints: 5 }
  ];
  return { score: factors.reduce((total, factor) => total + factor.points, 0), factors };
}

function makeTradePlan({ direction, model, entry, stop, target, score, factors, price, tickSize }) {
  const risk = direction === 'UP' ? entry - stop : stop - entry;
  const reward = direction === 'UP' ? target - entry : entry - target;
  const riskReward = risk > 0 ? reward / risk : 0;
  if (risk <= 0 || reward <= 0 || riskReward < 1) return null;

  const passed = direction === 'UP'
    ? price > entry + 2 * tickSize
    : price < entry - 2 * tickSize;
  const nearTrigger = Math.abs(price - entry) <= 2 * tickSize;
  return {
    direction,
    model,
    status: passed ? 'PASSED' : nearTrigger ? 'TRIGGER_NEAR' : 'WAIT_FOR_TRIGGER',
    entry,
    stop,
    target,
    risk,
    reward,
    riskReward,
    evidenceScore: score,
    evidence: factors,
    maximumHold: 'Intraday only; exit at session close, or earlier at target, stop, or confirmed opposing 5-minute structure.'
  };
}

export function analyzeMarketHistory({ sessions = [], tickSize = 0.05, now = Date.now(), marketDay = true } = {}) {
  const safeTickSize = validNumber(tickSize) && tickSize > 0 ? tickSize : 0.05;
  const orderedSessions = [...sessions].sort((left, right) => left.date.localeCompare(right.date));
  const current = orderedSessions.at(-1) || null;
  const previous = current
    ? orderedSessions.slice(0, -1).reverse().find((session) => validNumber(session.vah) && validNumber(session.val)) || null
    : null;
  const candles = current?.candles?.[5] || current?.candles?.['5'] || [];
  const closedCandles = candles
    .filter((candle) => validNumber(candle.time) && candle.time + 5 * 60000 <= now)
    .sort((left, right) => left.time - right.time);
  const latest = closedCandles.at(-1) || null;
  const latestWindow = closedCandles;
  const upBodies = latestWindow.filter((candle) => candle.close > candle.open).length;
  const downBodies = latestWindow.filter((candle) => candle.close < candle.open).length;
  const movement = latestWindow.length >= 2 ? latestWindow.at(-1).close - latestWindow[0].open : 0;
  const higherHighs = latestWindow.slice(1).filter((candle, index) => candle.high > latestWindow[index].high).length;
  const higherLows = latestWindow.slice(1).filter((candle, index) => candle.low > latestWindow[index].low).length;
  const lowerHighs = latestWindow.slice(1).filter((candle, index) => candle.high < latestWindow[index].high).length;
  const lowerLows = latestWindow.slice(1).filter((candle, index) => candle.low < latestWindow[index].low).length;
  const trendDirection = movement > safeTickSize && upBodies >= 2 && higherHighs >= 2 && higherLows >= 1 ? 'UP'
    : movement < -safeTickSize && downBodies >= 2 && lowerLows >= 2 && lowerHighs >= 1 ? 'DOWN'
      : 'MIXED';
  const recentDelta = closedCandles.slice(-3).reduce((total, candle) => total + candle.delta, 0);
  const sessionDelta = closedCandles.reduce((total, candle) => total + candle.delta, 0);
  const currentPrice = validNumber(current?.price) ? current.price : latest?.close ?? null;
  const previousLevels = previous ? localProfileLevels(previous, safeTickSize) : { hvns: [], lvns: [] };
  const currentLevels = current ? localProfileLevels(current, safeTickSize) : { hvns: [], lvns: [] };
  const levels = marketLevels(orderedSessions, safeTickSize);
  const lastImbalance = latest ? candleImbalances(latest, safeTickSize) : null;
  const fullSessionFootprint = sessionFootprint(closedCandles, safeTickSize);
  const actualFootprint = closedCandles.some((candle) => candle.levels?.length);
  const aggressiveFlow = lastImbalance ? {
    direction: lastImbalance.aggressiveDirection,
    buyerVolume: lastImbalance.buyerVolume,
    sellerVolume: lastImbalance.sellerVolume
  } : { direction: 'UNKNOWN', buyerVolume: 0, sellerVolume: 0 };
  const keyLevels = [
    ['Prior VAH', previous?.vah],
    ['Prior POC', previous?.poc],
    ['Prior VAL', previous?.val],
    ['Prior high', previous?.high],
    ['Prior low', previous?.low],
    ['Session VAH', current?.vah],
    ['Session POC', current?.poc],
    ['Session VAL', current?.val],
    ['Session high', current?.high],
    ['Session low', current?.low],
    ...previousLevels.hvns.map((price) => ['Prior HVN', price]),
    ...previousLevels.lvns.map((price) => ['Prior LVN', price]),
    ...currentLevels.hvns.map((price) => ['Session HVN', price]),
    ...currentLevels.lvns.map((price) => ['Session LVN', price])
  ].filter(([, price]) => validNumber(price));
  const aggressiveAtImportantLevels = latest
    ? keyLevels.filter(([, price]) => latest.low <= price + 2 * safeTickSize && latest.high >= price - 2 * safeTickSize)
      .map(([name, price]) => ({
        name,
        price,
        ...aggressionAtLevel(latest, price, safeTickSize)
      }))
    : [];
  const levelBuyerVolume = aggressiveAtImportantLevels.reduce((total, level) => total + level.buyerVolume, 0);
  const levelSellerVolume = aggressiveAtImportantLevels.reduce((total, level) => total + level.sellerVolume, 0);
  const levelAggressiveDirection = levelBuyerVolume > levelSellerVolume * 1.25 ? 'UP'
    : levelSellerVolume > levelBuyerVolume * 1.25 ? 'DOWN' : aggressiveFlow.direction;
  const sessionOpen = current?.open ?? closedCandles[0]?.open ?? null;
  const sessionMove = validNumber(currentPrice) && validNumber(sessionOpen) ? currentPrice - sessionOpen : null;
  const priceDirection = sessionMove > safeTickSize ? 'UP'
    : sessionMove < -safeTickSize ? 'DOWN' : trendDirection;
  const deltaArea = deltaEntryArea(closedCandles, priceDirection, currentPrice, safeTickSize);
  const reversalSetup = analyzeReversalSetup(closedCandles, trendDirection, safeTickSize);
  const priorValueAvailable = validNumber(previous?.vah) && validNumber(previous?.val);
  const openingDirection = priorValueAvailable && validNumber(sessionOpen)
    ? sessionOpen > previous.vah ? 'UP' : sessionOpen < previous.val ? 'DOWN' : 'INSIDE'
    : 'UNKNOWN';
  const priceVsPreviousValue = priorValueAvailable && validNumber(currentPrice)
    ? currentPrice > previous.vah ? 'ABOVE_VALUE'
      : currentPrice < previous.val ? 'BELOW_VALUE'
        : 'INSIDE_VALUE'
    : 'UNKNOWN';
  const deltaAlignment = trendDirection !== 'MIXED' && sessionDelta !== 0
    ? Math.sign(sessionDelta) === (trendDirection === 'UP' ? 1 : -1) ? 'ALIGNED' : 'DIVERGING'
    : 'UNCLEAR';
  const updatedAt = current?.updatedAt ? Date.parse(current.updatedAt) : NaN;
  const dataAge = now - updatedAt;
  const marketDataFresh = validNumber(updatedAt) && dataAge >= -30000 && dataAge <= 120000;
  const footprintUpdatedAt = current?.footprintUpdatedAt ? Date.parse(current.footprintUpdatedAt) : NaN;
  const footprintAge = now - footprintUpdatedAt;
  const footprintDataFresh = validNumber(footprintUpdatedAt) && footprintAge >= -30000 && footprintAge <= 120000;
  const evidence = {
    trendDirection,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    recentDelta,
    sessionDelta,
    sessionImbalance: fullSessionFootprint.imbalance,
    priceDirection,
    deltaArea,
    reversalSetup,
    buyingArea: fullSessionFootprint.buyingArea,
    sellingArea: fullSessionFootprint.sellingArea,
    sessionBuyerVolume: fullSessionFootprint.positiveVolume,
    sessionSellerVolume: fullSessionFootprint.negativeVolume,
    deltaAlignment,
    cumulativeDelta: latest?.cvd ?? null,
    lastImbalance,
    aggressiveFlow,
    aggressiveAtImportantLevels,
    currentPrice,
    sessionOpen,
    sessionMove,
    openingDirection,
    priceVsPreviousValue,
    marketDataFresh,
    footprintDataFresh,
    latestCandleTime: latest?.time ?? null,
    completedCandleCount: closedCandles.length,
    previousDate: previous?.date ?? null,
    previousLevels: previous ? {
      vah: previous.vah ?? null,
      poc: previous.poc ?? null,
      val: previous.val ?? null,
      high: previous.high ?? null,
      low: previous.low ?? null,
      hvns: previousLevels.hvns,
      lvns: previousLevels.lvns
    } : null,
    currentLevels
  };

  const structureContext = trendDirection === 'UP'
    ? 'Higher-high / higher-low structure is leaning upward.'
    : trendDirection === 'DOWN'
      ? 'Lower-high / lower-low structure is leaning downward.'
      : 'Five-minute structure is mixed; direction is not established.';
  const deltaContext = deltaAlignment === 'ALIGNED'
    ? 'Full-session footprint delta confirms the structure.'
    : deltaAlignment === 'DIVERGING'
      ? 'Full-session footprint delta diverges from price structure.'
      : 'Full-session footprint delta is not decisive.';
  const aggressionContext = aggressiveFlow.direction === 'UP'
    ? `Buyers were the aggressive side in the latest completed footprint (${aggressiveFlow.buyerVolume} ask vs ${aggressiveFlow.sellerVolume} bid volume).`
    : aggressiveFlow.direction === 'DOWN'
      ? `Sellers were the aggressive side in the latest completed footprint (${aggressiveFlow.sellerVolume} bid vs ${aggressiveFlow.buyerVolume} ask volume).`
      : actualFootprint
        ? 'Latest completed footprint shows no 1.25x aggressive-volume imbalance.'
        : 'Waiting for actual price-level bid/ask footprint.';
  const levelAggressionContext = aggressiveAtImportantLevels.length
    ? aggressiveAtImportantLevels.map((level) => `${level.name} ${level.price}: buyers ${level.buyerVolume}, sellers ${level.sellerVolume} (${level.direction})`).join('; ')
    : 'No key prior/session profile level was tested by the latest completed footprint candle.';
  const marketBehavior = `${structureContext} ${deltaContext} ${aggressionContext} Price is ${priceVsPreviousValue.toLowerCase().replaceAll('_', ' ')} versus prior value. At tested profile levels: ${levelAggressionContext}`;
  const confluences = [
    { name: '5-minute structure', present: trendDirection !== 'MIXED', detail: structureContext },
    { name: 'Full-session footprint delta', present: deltaAlignment === 'ALIGNED', detail: `${deltaContext} Session delta ${sessionDelta}.` },
    { name: 'Full-session stacked imbalance', present: fullSessionFootprint.imbalance.direction === trendDirection && trendDirection !== 'MIXED', detail: `Across ${closedCandles.length} completed candles: ${fullSessionFootprint.imbalance.direction} (${fullSessionFootprint.imbalance.buyStack} buy / ${fullSessionFootprint.imbalance.sellStack} sell stack).` },
    { name: 'Aggressive bid/ask at key levels', present: aggressiveAtImportantLevels.some((level) => level.direction === trendDirection && trendDirection !== 'MIXED'), detail: levelAggressionContext },
    { name: 'Prior-session context', present: priorValueAvailable, detail: priorValueAvailable ? `Price is ${priceVsPreviousValue.toLowerCase().replaceAll('_', ' ')}; prior VAH ${previous.vah}, POC ${previous.poc}, VAL ${previous.val}.` : 'Prior value area is unavailable.' },
    { name: 'Fresh real footprint', present: actualFootprint && footprintDataFresh, detail: actualFootprint && footprintDataFresh ? 'Completed candle has FYERS price-level Bid/Ask data.' : 'Fresh FYERS price-level Bid/Ask data is required.' }
  ];

  const noPlan = (reason, readiness = actualFootprint ? 'CONTEXT_ONLY' : 'WAITING_FOR_REAL_FOOTPRINT') => ({
    ...evidence,
    marketBehavior,
    confluences,
    readiness,
    reason,
    tradePlan: null
  });

  if (!marketDay) return noPlan('The market is closed for the weekend. The latest saved session is shown for context only.', 'MARKET_CLOSED');
  if (!current || !closedCandles.length) return noPlan('Waiting for completed 5-minute FYERS footprint candles.');
  if (!actualFootprint) return noPlan('Waiting for saved price-level Bid/Ask footprint data.');
  if (!validNumber(currentPrice)) return noPlan('Waiting for a valid current traded price.');
  if (!marketDataFresh) return noPlan('Waiting for fresh live market data.', 'WAITING_FOR_FRESH_MARKET_DATA');
  if (!footprintDataFresh) return noPlan('Waiting for a fresh footprint capture.', 'WAITING_FOR_FRESH_FOOTPRINT_DATA');
  if (closedCandles.length < 3) return noPlan('Collect at least three completed 5-minute footprint candles.');

  const readiness = deltaArea?.accepted ? 'CONTINUATION_AREA_ACCEPTED'
    : deltaArea ? 'WAITING_FOR_AREA_ACCEPTANCE' : 'WAITING_FOR_AGGRESSIVE_DELTA_AREA';
  const reason = !deltaArea ? 'No strong same-direction Bid/Ask delta range found yet.'
    : deltaArea.accepted
      ? `Price accepted beyond the ${deltaArea.direction === 'UP' ? 'buying' : 'selling'} delta range; consider a continuation entry on a pullback into ${deltaArea.low}-${deltaArea.high}.`
      : `Strong ${deltaArea.direction === 'UP' ? 'buying' : 'selling'} delta range at ${deltaArea.low}-${deltaArea.high}; waiting for price acceptance beyond it.`;
  return {
    ...evidence,
    marketBehavior,
    confluences,
    readiness,
    reason,
    tradePlan: null
  };
}
