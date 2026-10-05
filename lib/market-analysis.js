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
  const latestWindow = closedCandles.slice(-4);
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
  const currentPrice = validNumber(current?.price) ? current.price : latest?.close ?? null;
  const previousLevels = previous ? localProfileLevels(previous, safeTickSize) : { hvns: [], lvns: [] };
  const currentLevels = current ? localProfileLevels(current, safeTickSize) : { hvns: [], lvns: [] };
  const levels = marketLevels(orderedSessions, safeTickSize);
  const lastImbalance = latest ? candleImbalances(latest, safeTickSize) : null;
  const actualFootprint = Boolean(latest?.levels?.length);
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
  const priorValueAvailable = validNumber(previous?.vah) && validNumber(previous?.val);
  const openingDirection = priorValueAvailable && validNumber(sessionOpen)
    ? sessionOpen > previous.vah ? 'UP' : sessionOpen < previous.val ? 'DOWN' : 'INSIDE'
    : 'UNKNOWN';
  const priceVsPreviousValue = priorValueAvailable && validNumber(currentPrice)
    ? currentPrice > previous.vah ? 'ABOVE_VALUE'
      : currentPrice < previous.val ? 'BELOW_VALUE'
        : 'INSIDE_VALUE'
    : 'UNKNOWN';
  const deltaAlignment = trendDirection !== 'MIXED' && recentDelta !== 0
    ? Math.sign(recentDelta) === (trendDirection === 'UP' ? 1 : -1) ? 'ALIGNED' : 'DIVERGING'
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
    ? 'Recent footprint delta confirms the structure.'
    : deltaAlignment === 'DIVERGING'
      ? 'Recent footprint delta diverges from price structure.'
      : 'Recent footprint delta is not decisive.';
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
    { name: 'Footprint delta', present: deltaAlignment === 'ALIGNED', detail: deltaContext },
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
  if (!actualFootprint) return noPlan('Price candles are present, but price-level bid/ask footprint data is not available.');
  if (!previous || !priorValueAvailable) return noPlan('Previous-session value area is required before evaluating an entry.');
  if (!validNumber(currentPrice)) return noPlan('Waiting for a valid current traded price.');
  if (!marketDataFresh) return noPlan('Live price or footprint data is stale. Refresh the FYERS capture before evaluating an entry.', 'WAITING_FOR_FRESH_MARKET_DATA');
  if (!footprintDataFresh) return noPlan('The latest 5-minute FYERS footprint capture is stale. Wait for a fresh footprint before evaluating an entry.', 'WAITING_FOR_FRESH_FOOTPRINT_DATA');
  if (closedCandles.length < 6) return noPlan('Collect at least six completed 5-minute footprint candles before evaluating an entry.');

  const candidates = [];
  const latestStackDirection = lastImbalance?.direction || 'NONE';

  if (trendDirection !== 'MIXED' && latestStackDirection === trendDirection) {
    const direction = trendDirection;
    const entry = direction === 'UP' ? latest.high + safeTickSize : latest.low - safeTickSize;
    const stop = direction === 'UP'
      ? Math.min(...closedCandles.slice(-3).map((candle) => candle.low)) - safeTickSize
      : Math.max(...closedCandles.slice(-3).map((candle) => candle.high)) + safeTickSize;
    const target = nearestTarget(levels, entry, direction, Math.abs(entry - stop));
    const locationConfirmed = levels.some((level) => latest.low <= level + 4 * safeTickSize
      && latest.high >= level - 4 * safeTickSize);
    const scored = scoreSetup({
      direction,
      trendDirection,
      setupType: 'CONTINUATION',
      delta: recentDelta,
      locationConfirmed,
      imbalanceDirection: latestStackDirection,
      aggressiveDirection: levelAggressiveDirection,
      openingDirection
    });
    if (locationConfirmed && target !== null && scored.score >= 70) {
      const plan = makeTradePlan({
        direction,
        model: 'Stacked imbalance continuation',
        entry,
        stop,
        target,
        score: scored.score,
        factors: scored.factors,
        price: currentPrice,
        tickSize: safeTickSize
      });
      if (plan && plan.status !== 'PASSED') candidates.push(plan);
    }
  }

  const supportResistance = [
    { price: previous.val, direction: 'UP', label: 'Previous VAL rejection' },
    { price: previous.vah, direction: 'DOWN', label: 'Previous VAH rejection' },
    { price: previous.low, direction: 'UP', label: 'Prior session low rejection' },
    { price: previous.high, direction: 'DOWN', label: 'Prior session high rejection' },
    { price: current.low, direction: 'UP', label: 'Session low rejection' },
    { price: current.high, direction: 'DOWN', label: 'Session high rejection' },
    { price: previous.poc, direction: trendDirection, label: 'Previous POC pullback' },
    { price: current.poc, direction: trendDirection, label: 'Current POC pullback' },
    ...previousLevels.lvns.map((price) => ({ price, direction: trendDirection, label: 'Prior LVN retest' })),
    ...currentLevels.lvns.map((price) => ({ price, direction: trendDirection, label: 'Session LVN retest' }))
  ].filter((level) => validNumber(level.price) && ['UP', 'DOWN'].includes(level.direction));

  for (const level of supportResistance) {
    const bar = latest;
    const direction = level.direction;
    const rejected = direction === 'UP'
      ? bar.low <= level.price + 2 * safeTickSize && bar.close > level.price && bar.delta > 0
      : bar.high >= level.price - 2 * safeTickSize && bar.close < level.price && bar.delta < 0;
    if (!rejected || Math.abs(currentPrice - level.price) > 4 * safeTickSize) continue;

    const entry = direction === 'UP' ? bar.high + safeTickSize : bar.low - safeTickSize;
    const stop = direction === 'UP' ? bar.low - safeTickSize : bar.high + safeTickSize;
    const target = nearestTarget(levels, entry, direction, Math.abs(entry - stop));
    const levelFlow = aggressiveAtImportantLevels.find((item) => Math.abs(item.price - level.price) <= 2 * safeTickSize);
    const setupType = trendDirection !== 'MIXED' && direction !== trendDirection ? 'REVERSAL' : 'CONTINUATION';
    const scored = scoreSetup({
      direction,
      trendDirection,
      setupType,
      delta: recentDelta,
      locationConfirmed: true,
      imbalanceDirection: latestStackDirection,
      aggressiveDirection: levelFlow?.direction || levelAggressiveDirection,
      openingDirection
    });
    if (target === null || scored.score < 70) continue;
    const plan = makeTradePlan({
      direction,
      model: setupType === 'REVERSAL'
        ? `${level.label} reversal`
        : level.label.includes('POC') ? level.label : `${level.label} continuation`,
      entry,
      stop,
      target,
      score: scored.score,
      factors: scored.factors,
      price: currentPrice,
      tickSize: safeTickSize
    });
    if (plan && plan.status !== 'PASSED') candidates.push(plan);
  }

  const tradePlan = candidates
    .sort((left, right) => right.evidenceScore - left.evidenceScore || right.riskReward - left.riskReward)[0] || null;
  return {
    ...evidence,
    marketBehavior,
    confluences: tradePlan
      ? tradePlan.evidence.map((factor) => ({
        name: factor.name,
        present: factor.points > 0,
        detail: `${factor.points}/${factor.maxPoints} points`
      })).concat(confluences.slice(2))
      : confluences,
    readiness: tradePlan ? 'PLAN_AVAILABLE' : 'CONTEXT_ONLY',
    reason: tradePlan
      ? `A ${tradePlan.direction === trendDirection ? 'continuation' : 'reversal'} setup is supported by the listed footprint and market-context confluences.`
      : 'No setup currently meets the evidence threshold and minimum 1:1 risk/reward; wait for clearer price action.',
    tradePlan
  };
}
