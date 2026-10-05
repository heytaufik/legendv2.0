import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fyersSdk from 'fyers-api-v3';
import { parse } from 'csv-parse/sync';
import { isAuthorizedCaptureRequest } from './lib/capture-auth.js';
import { createJsonDocumentStore } from './lib/json-document-store.js';
import { buildProfileBins, calculateValueArea, classifyOpening, detectLowVolumeZones, indiaDateKey, latestSessionBefore, pruneSessions, readSessionArchive, untestedHistoricalLowVolumeZones, writeSessionArchive } from './lib/session-profile.js';
import { mergeFyersOrderflow } from './lib/fyers-orderflow.js';
import { mergeOrderflowHistory, ORDERFLOW_RETENTION_SESSIONS, readOrderflowHistory, writeOrderflowHistory } from './lib/orderflow-history.js';
import { analyzeMarketHistory } from './lib/market-analysis.js';
import { selectFuturesContract } from './lib/futures-contract.js';
import { listOpenDemoTrades, readTradeOutcomes, recordTradeOutcomes, writeTradeOutcomes } from './lib/trade-outcomes.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(directory, 'data'));
const archivePath = path.join(dataDirectory, 'session-profiles.json');
const orderflowHistoryPath = path.join(dataDirectory, 'orderflow-history.json');
const tradeOutcomesPath = path.join(dataDirectory, 'setup-outcomes.json');
const documentStore = createJsonDocumentStore({
  connectionString: process.env.DATABASE_URL,
  documents: {
    'session-profiles': archivePath,
    'orderflow-history': orderflowHistoryPath,
    'setup-outcomes': tradeOutcomesPath
  }
});
const captureToken = process.env.LEGEND_CAPTURE_TOKEN || '';
const { fyersDataSocket } = fyersSdk;
const configuredInstruments = {
  NIFTY: process.env.FYERS_NIFTY_SYMBOL || '',
  SENSEX: process.env.FYERS_SENSEX_SYMBOL || ''
};
const instrumentTickSizes = { NIFTY: 0.05, SENSEX: 0.05 };
const activeContracts = { NIFTY: null, SENSEX: null };
const instrumentState = Object.fromEntries(Object.keys(configuredInstruments).map((key) => [key, {
  sessionDate: indiaDateKey(),
  price: null,
  previousClose: null,
  open: null,
  high: null,
  low: null,
  previousPrice: null,
  previousVolume: null,
  lastDirection: 0,
  delta: 0,
  cvd: 0,
  fyersOrderflow: null,
  profileSource: 'TICK_RULE_ESTIMATE',
  flow: [],
  orderflow: { 1: [], 3: [], 5: [], 15: [] },
  profile: new Map(),
  updatedAt: null
}]));
const streamClients = new Set();
let accessToken = '';
let marketSocket = null;
let lastSocketConnectAttempt = 0;
let connectionStatus = 'disconnected';
let connectionMessage = 'Loading active futures contracts from FYERS...';
let sessionArchive = {};
let orderflowHistory = {};
let tradeOutcomes = { signals: [] };
let archiveSaveTimer = null;
let archiveWriteQueue = Promise.resolve();
let orderflowWriteQueue = Promise.resolve();
let tradeOutcomesWriteQueue = Promise.resolve();

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(directory, 'public')));

app.use('/api/fyers-orderflow', (request, response, next) => {
  const origin = request.get('origin');
  if (origin === 'https://fyers.in') {
    response.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      Vary: 'Origin'
    });
  }
  if (request.method === 'OPTIONS') return response.sendStatus(origin === 'https://fyers.in' ? 204 : 403);
  next();
});

function createAuthState() {
  const payload = `${Date.now()}.${crypto.randomBytes(32).toString('base64url')}`;
  const signature = crypto.createHmac('sha256', process.env.FYERS_SECRET_ID).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function isValidAuthState(state) {
  if (typeof state !== 'string') return false;
  const [issuedAt, nonce, signature, extra] = state.split('.');
  if (!issuedAt || !nonce || !signature || extra !== undefined) return false;

  const timestamp = Number(issuedAt);
  const age = Date.now() - timestamp;
  if (!Number.isSafeInteger(timestamp) || age < -30000 || age > 10 * 60 * 1000) return false;

  const payload = `${issuedAt}.${nonce}`;
  const expected = crypto.createHmac('sha256', process.env.FYERS_SECRET_ID).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function safeFyersError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [accessToken, process.env.FYERS_SECRET_ID, process.env.FYERS_APP_ID]
    .filter(Boolean)
    .reduce((safeMessage, secret) => safeMessage.replaceAll(secret, '[redacted]'), message)
    .slice(0, 300);
}

function scheduleArchiveSave() {
  if (archiveSaveTimer) return;
  archiveSaveTimer = setTimeout(() => {
    archiveSaveTimer = null;
    const archiveToWrite = structuredClone(sessionArchive);
    archiveWriteQueue = archiveWriteQueue
      .then(() => documentStore.mode === 'postgres'
        ? documentStore.write('session-profiles', archiveToWrite)
        : writeSessionArchive(archivePath, archiveToWrite))
      .catch((error) => console.error('Could not persist session profiles:', error.message));
  }, 1000);
  archiveSaveTimer.unref();
}

function persistOrderflowHistory() {
  const historyToWrite = structuredClone(orderflowHistory);
  const write = orderflowWriteQueue.then(() => documentStore.mode === 'postgres'
    ? documentStore.write('orderflow-history', historyToWrite)
    : writeOrderflowHistory(orderflowHistoryPath, historyToWrite));
  orderflowWriteQueue = write.catch((error) => {
    console.error('Could not persist FYERS order-flow history:', error.message);
  });
  return write;
}

function persistTradeOutcomes() {
  const journalToWrite = structuredClone(tradeOutcomes);
  const write = tradeOutcomesWriteQueue.then(() => documentStore.mode === 'postgres'
    ? documentStore.write('setup-outcomes', journalToWrite)
    : writeTradeOutcomes(tradeOutcomesPath, journalToWrite));
  tradeOutcomesWriteQueue = write.catch((error) => {
    console.error('Could not persist setup outcomes:', error.message);
  });
  return write;
}

function normalizeOrderflowHistory(history, asOfDate) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) return {};
  const dates = Object.keys(history).filter((date) => date <= asOfDate).sort().slice(-ORDERFLOW_RETENTION_SESSIONS);
  return Object.fromEntries(dates.map((date) => [date, history[date]]));
}

async function readStoredSessionArchive(asOfDate) {
  if (documentStore.mode === 'local-json') return readSessionArchive(archivePath, asOfDate);
  const archive = await documentStore.read('session-profiles');
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) return {};
  return pruneSessions(archive, asOfDate);
}

async function readStoredOrderflowHistory(asOfDate) {
  if (documentStore.mode === 'local-json') return readOrderflowHistory(orderflowHistoryPath, asOfDate);
  return normalizeOrderflowHistory(await documentStore.read('orderflow-history'), asOfDate);
}

async function readStoredTradeOutcomes() {
  if (documentStore.mode === 'local-json') return readTradeOutcomes(tradeOutcomesPath);
  const journal = await documentStore.read('setup-outcomes');
  if (!journal || typeof journal !== 'object' || Array.isArray(journal) || !Array.isArray(journal.signals)) {
    return { signals: [] };
  }
  return journal;
}

function marketReadSessions(instrument) {
  const currentDate = indiaDateKey();
  const availableDates = [...new Set([
    ...Object.keys(orderflowHistory),
    ...Object.keys(sessionArchive)
  ])].filter((date) => date < currentDate && isWeekday(date)).sort();
  const priorSessions = availableDates.slice(isWeekday(currentDate) ? -1 : -2);
  const dates = [...priorSessions, ...(isWeekday(currentDate) ? [currentDate] : [])];
  const priorProfile = latestSessionBefore(sessionArchive, instrument, isWeekday(currentDate) ? currentDate : dates.at(-1) || currentDate);
  if (priorProfile && !dates.includes(priorProfile.date)) dates.push(priorProfile.date);
  dates.sort();
  return dates.map((date) => {
    const saved = orderflowHistory[date]?.[instrument] || {};
    const profileSession = sessionArchive[date]?.[instrument] || {};
    const current = date === currentDate ? instrumentState[instrument] : null;
    return {
      date,
      symbol: saved.symbol || configuredInstruments[instrument] || null,
      open: current?.open ?? profileSession.open ?? null,
      high: current?.high ?? profileSession.high ?? null,
      low: current?.low ?? profileSession.low ?? null,
      close: current?.price ?? profileSession.close ?? null,
      price: current?.price ?? profileSession.close ?? null,
      vah: profileSession.vah ?? saved.valueArea?.vah ?? null,
      poc: profileSession.poc ?? saved.valueArea?.poc ?? null,
      val: profileSession.val ?? saved.valueArea?.val ?? null,
      profile: saved.profile?.length
        ? saved.profile
        : Object.entries(profileSession.profile || {}).map(([price, volume]) => ({
          price: Number(price),
          volume: Number(volume)
        })),
      candles: saved.candles || {},
      candleUpdatedAt: current?.fyersOrderflow?.candleUpdatedAt || saved.candleUpdatedAt || {},
      footprintUpdatedAt: current?.fyersOrderflow?.candleUpdatedAt?.[5]
        || current?.fyersOrderflow?.candleUpdatedAt?.['5']
        || saved.candleUpdatedAt?.[5]
        || saved.candleUpdatedAt?.['5']
        || null,
      updatedAt: current?.updatedAt || saved.updatedAt || null
    };
  });
}

function updateTradeOutcomeJournal(instrument, allowNewSignals = true, { livePrice = null, previousPrice = null } = {}) {
  const sessions = marketReadSessions(instrument);
  const analysis = analyzeMarketHistory({
    sessions,
    tickSize: instrumentTickSizes[instrument] || 0.05,
    marketDay: isWeekday(indiaDateKey())
  });
  const nextOutcomes = recordTradeOutcomes(tradeOutcomes, {
    instrument,
    analysis,
    sessions,
    livePrice,
    previousPrice,
    allowNewSignals: allowNewSignals && isWeekday(indiaDateKey())
  });
  const changed = JSON.stringify(nextOutcomes) !== JSON.stringify(tradeOutcomes);
  if (changed) tradeOutcomes = nextOutcomes;
  return changed ? persistTradeOutcomes() : Promise.resolve();
}

function previousSessionFor(instrument, beforeDate = indiaDateKey()) {
  return latestSessionBefore(sessionArchive, instrument, beforeDate);
}

function saveCurrentSession(instrument) {
  const state = instrumentState[instrument];
  const date = state.sessionDate;
  const fyersProfileFresh = Boolean(state.fyersOrderflow?.profileUpdatedAt
    && Date.now() - Date.parse(state.fyersOrderflow.profileUpdatedAt) < 120000
    && state.fyersOrderflow.profile.length);
  const sessionProfile = fyersProfileFresh
    ? state.fyersOrderflow.profile.map((level) => [level.price, level.volume])
    : [...state.profile.entries()];
  const valueArea = calculateValueArea(sessionProfile);
  const profileSource = fyersProfileFresh ? 'FYERS_CHART' : state.profileSource;
  sessionArchive[date] ??= {};
  sessionArchive[date][instrument] = {
    open: state.open,
    high: state.high,
    low: state.low,
    close: state.price,
    vah: valueArea.vah,
    poc: valueArea.poc,
    val: valueArea.val,
    totalVolume: valueArea.totalVolume,
    profile: Object.fromEntries(sessionProfile),
    profileSource,
    updatedAt: state.updatedAt
  };
  sessionArchive = pruneSessions(sessionArchive, date);
  scheduleArchiveSave();
}

function restoreSession(instrument, date) {
  const state = instrumentState[instrument];
  const saved = sessionArchive[date]?.[instrument];
  state.sessionDate = date;
  state.profile = new Map(Object.entries(saved?.profile || {}).map(([price, volume]) => [Number(price), Number(volume)]));
  state.profileSource = saved?.profileSource || 'TICK_RULE_ESTIMATE';
  if (saved) {
    state.open = saved.open ?? null;
    state.high = saved.high ?? null;
    state.low = saved.low ?? null;
    state.price = saved.close ?? null;
  }
}

async function loadSessionArchive() {
  await documentStore.initialize();
  try {
    sessionArchive = await readStoredSessionArchive(indiaDateKey());
  } catch (error) {
    console.error('Could not load saved session profiles:', error.message);
    if (documentStore.mode === 'postgres') throw error;
  }
  const today = indiaDateKey();
  for (const instrument of Object.keys(instrumentState)) restoreSession(instrument, today);
  try {
    orderflowHistory = await readStoredOrderflowHistory(today);
  } catch (error) {
    console.error('Could not load saved FYERS order-flow history:', error.message);
    if (documentStore.mode === 'postgres') throw error;
  }
  try {
    tradeOutcomes = await readStoredTradeOutcomes();
  } catch (error) {
    console.error('Could not load saved setup outcomes:', error.message);
    if (documentStore.mode === 'postgres') throw error;
  }
  for (const instrument of Object.keys(instrumentState)) {
    const saved = orderflowHistory[today]?.[instrument];
    if (!saved) continue;
    instrumentState[instrument].fyersOrderflow = {
      symbol: saved.symbol,
      updatedAt: saved.updatedAt,
      footprintUpdatedAt: saved.footprintUpdatedAt || null,
      profileUpdatedAt: saved.profileUpdatedAt || null,
      candles: saved.candles || {},
      candleUpdatedAt: saved.candleUpdatedAt || {},
      profile: saved.profile || [],
      valueArea: saved.valueArea || { vah: null, poc: null, val: null, totalVolume: 0 },
      cvd: saved.cvd ?? null
    };
  }
  for (const instrument of Object.keys(instrumentState)) {
    try {
      await updateTradeOutcomeJournal(instrument, false);
    } catch (error) {
      console.error(`Could not reconcile saved setup outcomes for ${instrument}:`, error.message);
    }
  }
}

function resetForNewSession(instrument, date) {
  const state = instrumentState[instrument];
  state.previousClose = null;
  state.previousPrice = null;
  state.previousVolume = null;
  state.lastDirection = 0;
  state.delta = 0;
  state.cvd = 0;
  state.fyersOrderflow = null;
  state.profileSource = 'TICK_RULE_ESTIMATE';
  state.flow = [];
  state.orderflow = { 1: [], 3: [], 5: [], 15: [] };
  state.updatedAt = null;
  restoreSession(instrument, date);
}

app.get('/auth/login', (_request, response) => {
  if (!process.env.FYERS_APP_ID || !process.env.FYERS_SECRET_ID || !process.env.FYERS_REDIRECT_URI) {
    return response.status(503).send('Set FYERS_APP_ID, FYERS_SECRET_ID, and FYERS_REDIRECT_URI before connecting.');
  }
  const params = new URLSearchParams({
    client_id: process.env.FYERS_APP_ID,
    redirect_uri: process.env.FYERS_REDIRECT_URI,
    response_type: 'code',
    state: createAuthState()
  });
  response.redirect(`https://api-t1.fyers.in/api/v3/generate-authcode?${params}`);
});

app.get(['/auth/callback', '/api/auth/callback'], async (request, response) => {
  const authCode = request.query.auth_code;
  if (!authCode) {
    return response.status(400).send('FYERS did not return an authorization code.');
  }
  if (!process.env.FYERS_SECRET_ID || !isValidAuthState(request.query.state)) {
    return response.status(400).send('FYERS login state did not match. Start a new connection.');
  }

  const appId = process.env.FYERS_APP_ID || '';
  const secretId = process.env.FYERS_SECRET_ID || '';
  if (!appId || !secretId) {
    return response.status(503).send('Set FYERS_APP_ID and FYERS_SECRET_ID before connecting.');
  }
  const appIdHash = crypto.createHash('sha256').update(`${appId}:${secretId}`).digest('hex');
  try {
    const tokenResponse = await fetch('https://api-t1.fyers.in/api/v3/validate-authcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code: authCode })
    });
    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || tokenResult.s !== 'ok' || !tokenResult.access_token) {
      connectionStatus = 'disconnected';
      connectionMessage = 'FYERS token exchange failed. Try connecting again.';
      return response.redirect('/?connection=failed');
    }

    accessToken = tokenResult.access_token;
    if (Object.values(activeContracts).some((contract) => !contract || contract.expiryTimestamp <= Date.now())) {
      await loadActiveFutures();
    }
    startMarketSocket();
    response.redirect('/?connection=started');
  } catch {
    connectionStatus = 'disconnected';
    connectionMessage = 'Could not reach FYERS to exchange the login code.';
    response.redirect('/?connection=failed');
  }
});

function snapshot() {
  const instruments = {};
  for (const [key, symbol] of Object.entries(configuredInstruments)) {
    const state = instrumentState[key];
    const fyers = state.fyersOrderflow;
    const now = Date.now();
    const fyersProfileFresh = Boolean(fyers?.profileUpdatedAt && now - Date.parse(fyers.profileUpdatedAt) < 120000);
    const fyersFootprintFresh = Boolean(fyers?.footprintUpdatedAt && now - Date.parse(fyers.footprintUpdatedAt) < 120000);
    const freshFyersTimeframes = Object.fromEntries(Object.entries(fyers?.candles || {})
      .filter(([timeframe]) => fyersFootprintFresh && fyers?.candleUpdatedAt?.[timeframe] && now - Date.parse(fyers.candleUpdatedAt[timeframe]) < 120000));
    const profileEntries = fyersProfileFresh && fyers.profile.length
      ? fyers.profile.map((level) => [level.price, level.volume])
      : [...state.profile.entries()];
    const valueArea = calculateValueArea(profileEntries);
    const priorSession = previousSessionFor(key, state.sessionDate);
    const activeMarketSession = isWeekday(indiaDateKey()) && state.sessionDate === indiaDateKey();
    const openingDirection = activeMarketSession
      ? classifyOpening(state.open, priorSession)
      : 'WAITING_FOR_MARKET_SESSION';
    const firstFlowBucket = Math.floor(Date.now() / 300000) * 300000 - 11 * 300000;
    const flowBuckets = Array.from({ length: 12 }, (_, index) => ({ time: firstFlowBucket + index * 300000, delta: 0 }));
    for (const tick of state.flow) {
      const index = Math.floor((tick.time - firstFlowBucket) / 300000);
      if (index >= 0 && index < flowBuckets.length) flowBuckets[index].delta += tick.delta;
    }
    const tickSize = instrumentTickSizes[key] || 0.05;
    const tradedPrices = profileEntries.map(([price]) => price);
    const minimumPrice = Math.min(...tradedPrices, state.low ?? Infinity);
    const maximumPrice = Math.max(...tradedPrices, state.high ?? -Infinity);
    let profile = profileEntries.length ? buildProfileBins(profileEntries, tickSize) : [];
    if (profile.length && Number.isFinite(minimumPrice) && Number.isFinite(maximumPrice)) {
      profile = profile.map((level) => ({ ...level, volume: level.volume || 0 }));
    }
    const todayLvnZones = detectLowVolumeZones(profile, valueArea).map((zone) => ({
      ...zone,
      date: state.sessionDate,
      source: fyersProfileFresh ? 'FYERS_CHART' : state.profileSource
    }));
    const lvnIndices = new Set(todayLvnZones.flatMap((zone) => Array.from(
      { length: zone.endIndex - zone.startIndex + 1 },
      (_, index) => zone.startIndex + index
    )));
    profile.forEach((level, index) => {
      level.isVah = valueArea.vah !== null && valueArea.vah >= level.price && valueArea.vah < level.high;
      level.isVal = valueArea.val !== null && valueArea.val >= level.price && valueArea.val < level.high;
      level.isPoc = valueArea.poc !== null && valueArea.poc >= level.price && valueArea.poc < level.high;
      level.inValueArea = valueArea.val !== null && level.price <= valueArea.vah && level.high > valueArea.val;
      level.isLvn = lvnIndices.has(index);
      level.isDayLow = state.low !== null && state.low >= level.price && state.low < level.high;
    });
    const historicalLvnZones = untestedHistoricalLowVolumeZones(
      sessionArchive,
      key,
      state.sessionDate,
      profileEntries,
      tickSize
    );
    const lvns = todayLvnZones.map((zone) => zone.center);
    const fyersFiveMinute = freshFyersTimeframes[5]?.at(-1) || null;
    const estimatedDelta = state.flow
      .filter((tick) => tick.time >= now - 5 * 60 * 1000)
      .reduce((total, tick) => total + tick.delta, 0);
    const fyersOrderflow = fyers ? {
      symbol: fyers.symbol,
      updatedAt: fyers.updatedAt,
      footprintUpdatedAt: fyers.footprintUpdatedAt,
      profileUpdatedAt: fyers.profileUpdatedAt,
      footprintFresh: fyersFootprintFresh,
      profileFresh: fyersProfileFresh,
      candleFresh: Object.fromEntries(Object.keys(fyers?.candles || {}).map((timeframe) => [timeframe, Boolean(freshFyersTimeframes[timeframe])])),
      cvd: fyers.cvd,
      candles: fyers.candles,
      candleUpdatedAt: fyers.candleUpdatedAt,
      profile: fyers.profile,
      valueArea: fyers.valueArea
    } : null;
    instruments[key] = {
      symbol,
      contract: activeContracts[key],
      configured: Boolean(symbol),
      sessionDate: state.sessionDate,
      price: state.price,
      change: state.price !== null && state.previousClose !== null ? state.price - state.previousClose : null,
      changePercent: state.price !== null && state.previousClose ? ((state.price - state.previousClose) / state.previousClose) * 100 : null,
      open: state.open,
      high: state.high,
      low: state.low,
      delta: fyersFiveMinute ? fyersFiveMinute.delta : estimatedDelta,
      deltaSource: fyersFiveMinute ? 'FYERS_CHART' : 'TICK_RULE_ESTIMATE',
      cvd: fyersProfileFresh ? fyers.cvd : state.cvd,
      cvdSource: fyersProfileFresh ? 'FYERS_CHART' : 'TICK_RULE_ESTIMATE',
      flow: freshFyersTimeframes[5]?.length
        ? freshFyersTimeframes[5].slice(-12).map(({ time, delta }) => ({ time, delta }))
        : state.flow.length ? flowBuckets : [],
      flowSource: freshFyersTimeframes[5]?.length ? 'FYERS_CHART' : 'TICK_RULE_ESTIMATE',
      orderflow: { ...state.orderflow, ...freshFyersTimeframes },
      orderflowSource: Object.keys(freshFyersTimeframes).length ? 'FYERS_CHART' : 'TICK_RULE_ESTIMATE',
      fyersOrderflow,
      profileSource: fyersProfileFresh ? 'FYERS_CHART' : state.profileSource,
      profile,
      lvns,
      todayLvnZones,
      historicalLvnZones,
      session: {
        open: state.open,
        high: state.high,
        low: state.low,
        close: state.price,
        date: state.sessionDate,
        ...valueArea
      },
      openingConviction: {
        direction: openingDirection,
        open: state.open,
        previousDate: priorSession?.date ?? null,
        previousVah: priorSession?.vah ?? null,
        previousVal: priorSession?.val ?? null
      },
      ...valueArea,
      updatedAt: state.updatedAt
    };
  }
  return {
    mode: connectionStatus === 'connected' ? 'live' : accessToken ? 'connecting' : 'disconnected',
    status: connectionStatus,
    message: connectionMessage,
    trading: false,
    instruments,
    timestamp: new Date().toISOString()
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of streamClients) client.write(payload);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWeekday(date) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: 'Asia/Kolkata'
  }).format(new Date(`${date}T12:00:00+05:30`));
  return weekday !== 'Sat' && weekday !== 'Sun';
}

async function loadActiveFutures() {
  const masters = [
    { key: 'NIFTY', url: 'https://public.fyers.in/sym_details/NSE_FO.csv' },
    { key: 'SENSEX', url: 'https://public.fyers.in/sym_details/BSE_FO.csv' }
  ];
  const results = await Promise.allSettled(masters.map(async ({ key, url }) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`FYERS symbol master returned ${response.status}`);
    const records = parse(await response.text(), { skip_empty_lines: true, relax_column_count: true });
    const contract = selectFuturesContract(records, key, configuredInstruments[key]);
    configuredInstruments[key] = contract.symbol;
    activeContracts[key] = contract;
    instrumentTickSizes[key] = numberOrNull(contract.tickSize) || instrumentTickSizes[key];
  }));
  const failed = results.filter((result) => result.status === 'rejected');
  connectionMessage = failed.length
    ? 'Could not load all active futures contracts. Check the server network connection.'
    : `Active futures contracts loaded: ${Object.values(activeContracts).filter(Boolean).length}. Connect FYERS to start live market data.`;
  broadcast();
}

function handleMarketMessage(message) {
  if (Array.isArray(message)) {
    message.forEach(handleMarketMessage);
    return;
  }
  if (!message || typeof message !== 'object') return;
  const symbol = message.symbol ?? message.ticker;
  const key = Object.keys(configuredInstruments).find((name) => configuredInstruments[name] && configuredInstruments[name] === symbol);
  if (!key) return;

  const state = instrumentState[key];
  const marketDate = indiaDateKey();
  if (state.sessionDate !== marketDate) resetForNewSession(key, marketDate);
  const previousPrice = state.price;
  const price = numberOrNull(message.ltp ?? message.last_price ?? message.price);
  const volume = numberOrNull(message.vol_traded_today ?? message.volume);

  if (price !== null) {
    if (volume !== null && state.previousVolume !== null && volume > state.previousVolume) {
      const traded = volume - state.previousVolume;
      const priceDirection = Math.sign(price - (state.previousPrice ?? price));
      if (priceDirection) state.lastDirection = priceDirection;
      const direction = state.lastDirection;
      const delta = direction * traded;
      const tickTime = Date.now();
      const tickSize = instrumentTickSizes[key];
      const profilePrice = Math.round(price / tickSize) * tickSize;
      state.profile.set(profilePrice, (state.profile.get(profilePrice) || 0) + traded);
      state.cvd += delta;
      for (const minutes of [1, 3, 5, 15]) {
        const timeframe = minutes * 60 * 1000;
        const bucketTime = Math.floor(tickTime / timeframe) * timeframe;
        const candles = state.orderflow[minutes];
        let candle = candles.at(-1);
        if (!candle || candle.time !== bucketTime) {
          candle = { time: bucketTime, open: price, high: price, low: price, close: price, volume: 0, delta: 0, cvd: state.cvd };
          candles.push(candle);
          if (candles.length > 390) candles.shift();
        }
        candle.high = Math.max(candle.high, price);
        candle.low = Math.min(candle.low, price);
        candle.close = price;
        candle.volume += traded;
        candle.delta += delta;
        candle.cvd = state.cvd;
      }
      if (direction) {
        state.flow.push({ time: tickTime, delta });
        state.flow = state.flow.filter((tick) => tick.time >= tickTime - 24 * 60 * 60 * 1000);
      }
    }
    state.previousPrice = price;
    state.price = price;
  }
  if (volume !== null) state.previousVolume = volume;
  state.previousClose = numberOrNull(message.prev_close_price ?? message.previous_close_price) ?? state.previousClose;
  state.open = numberOrNull(message.open_price ?? message.open) ?? state.open;
  state.high = numberOrNull(message.high_price ?? message.high) ?? state.high;
  state.low = numberOrNull(message.low_price ?? message.low) ?? state.low;
  state.updatedAt = new Date().toISOString();
  saveCurrentSession(key);
  if (price !== null && tradeOutcomes.signals.some((signal) => signal.instrument === key && signal.status !== 'RESOLVED')) {
    void updateTradeOutcomeJournal(key, false, { livePrice: price, previousPrice })
      .catch((error) => console.error(`Could not update live demo setup for ${key}:`, error.message));
  }
  broadcast();
}

function startMarketSocket() {
  const symbols = Object.values(configuredInstruments).filter(Boolean);
  if (!symbols.length) {
    connectionStatus = 'disconnected';
    connectionMessage = 'Set FYERS_NIFTY_SYMBOL and FYERS_SENSEX_SYMBOL to your active futures contracts.';
    broadcast();
    return;
  }
  connectionStatus = 'connecting';
  connectionMessage = 'Connecting to FYERS market feed...';
  try {
    marketSocket = fyersDataSocket.getInstance(`${process.env.FYERS_APP_ID}:${accessToken}`, undefined, false);
    const socket = marketSocket;
    lastSocketConnectAttempt = Date.now();
    let subscriptionStarted = false;
    let connectionAttempts = 0;
    const subscribeWhenReady = () => {
      if (socket !== marketSocket || subscriptionStarted) return;
      if (socket.isConnected?.()) {
        try {
          socket.subscribe(symbols, false, 1);
          socket.mode(socket.FullMode, 1);
          subscriptionStarted = true;
          connectionStatus = 'connected';
          connectionMessage = 'Live FYERS market feed connected. Footprint capture is received separately from the desktop FYERS Order Flow chart.';
        } catch (error) {
          console.error('Could not subscribe to the FYERS market feed:', safeFyersError(error));
          connectionStatus = 'disconnected';
          connectionMessage = 'FYERS feed connected, but market data subscription failed. Check Render logs.';
        }
        broadcast();
        return;
      }
      connectionAttempts += 1;
      if (connectionAttempts >= 50) {
        connectionStatus = 'connecting';
        connectionMessage = 'FYERS market socket did not become ready; the server will retry automatically.';
        broadcast();
        return;
      }
      const retryTimer = setTimeout(subscribeWhenReady, 200);
      retryTimer.unref();
    };

    marketSocket.on('connect', () => {
      lastSocketConnectAttempt = Date.now();
      subscribeWhenReady();
    });
    marketSocket.on('message', handleMarketMessage);
    marketSocket.on('error', (error) => {
      console.error('FYERS market feed error:', safeFyersError(error));
      connectionStatus = 'connecting';
      connectionMessage = 'FYERS market feed interrupted; reconnecting automatically. Reauthorize only after the server restarts or the FYERS token expires.';
      broadcast();
    });
    marketSocket.on('close', () => {
      subscriptionStarted = false;
      connectionStatus = 'connecting';
      connectionMessage = 'FYERS market feed closed; reconnecting automatically. Reauthorize only after the server restarts or the FYERS token expires.';
      broadcast();
    });
    marketSocket.autoreconnect(5);
    marketSocket.connect();
  } catch (error) {
    console.error('Could not start the FYERS market feed:', safeFyersError(error));
    connectionStatus = 'disconnected';
    connectionMessage = 'Could not start FYERS market feed. Check Render logs.';
    broadcast();
  }
}

const marketSocketSupervisor = setInterval(() => {
  if (!accessToken || !marketSocket || marketSocket.isConnected?.()) return;
  if (Date.now() - lastSocketConnectAttempt < 45000) return;

  lastSocketConnectAttempt = Date.now();
  connectionStatus = 'connecting';
  connectionMessage = 'FYERS feed is still offline; retrying automatically. Your dashboard session remains connected while this server stays awake.';
  broadcast();
  try {
    marketSocket.connect();
  } catch (error) {
    console.error('Could not retry the FYERS market feed:', safeFyersError(error));
  }
}, 10000);
marketSocketSupervisor.unref();

app.post('/webhook', (request, response) => {
  console.log('FYERS webhook received:', request.body?.type || 'order update');
  response.sendStatus(200);
});

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    mode: snapshot().mode,
    persistence: {
      mode: documentStore.mode,
      durable: documentStore.mode === 'postgres'
    },
    trading: false,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/market-state', (_request, response) => {
  response.json(snapshot());
});

app.get('/api/orderflow-history/:instrument', (request, response) => {
  const instrument = request.params.instrument.toUpperCase();
  if (!Object.hasOwn(instrumentState, instrument)) {
    return response.status(404).json({ error: 'Unsupported instrument' });
  }

  const currentDate = indiaDateKey();
  const sessions = marketReadSessions(instrument);
  response.json({
    instrument,
    marketDay: isWeekday(currentDate),
    retentionSessions: 2,
    contract: activeContracts[instrument],
    tickSize: instrumentTickSizes[instrument] || 0.05,
    sessions,
    analysis: analyzeMarketHistory({
      sessions,
      tickSize: instrumentTickSizes[instrument] || 0.05,
      marketDay: isWeekday(currentDate)
    }),
    demoTrades: listOpenDemoTrades(tradeOutcomes, instrument, currentDate, instrumentState[instrument].price)
  });
});

app.get('/api/market-stream', (request, response) => {
  response.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.flushHeaders();
  response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  streamClients.add(response);
  request.on('close', () => streamClients.delete(response));
});

const streamHeartbeat = setInterval(() => {
  for (const client of streamClients) {
    if (client.destroyed || client.writableEnded) {
      streamClients.delete(client);
      continue;
    }
    client.write(': keep-alive\n\n');
  }
}, 25000);
streamHeartbeat.unref();

await loadSessionArchive();

loadActiveFutures().catch(() => {
  connectionMessage = 'Could not load active futures contracts from FYERS.';
  broadcast();
});

app.listen(port, () => {
  console.log(`Market dashboard running at http://localhost:${port}`);
});

app.post('/api/fyers-orderflow', async (request, response) => {
  const remoteAddress = request.socket.remoteAddress;
  if (!isAuthorizedCaptureRequest({
    remoteAddress,
    authorization: request.get('authorization'),
    configuredToken: captureToken
  })) {
    return response.status(captureToken ? 401 : 503).json({
      ok: false,
      error: captureToken ? 'Invalid capture authorization' : 'Remote capture is disabled until LEGEND_CAPTURE_TOKEN is configured'
    });
  }
  const { symbol, endpoint, payload, timeframe } = request.body || {};
  const key = Object.keys(configuredInstruments).find((instrument) => configuredInstruments[instrument] === symbol)
    || (/:NIFTY\d.*FUT$/i.test(symbol || '') ? 'NIFTY' : /:SENSEX\d.*FUT$/i.test(symbol || '') ? 'SENSEX' : null);
  if (!key) return response.status(400).json({ ok: false, error: 'Unsupported FYERS futures symbol' });
  try {
    instrumentState[key].fyersOrderflow = mergeFyersOrderflow(instrumentState[key].fyersOrderflow, { symbol, endpoint, payload, timeframe });
    orderflowHistory = mergeOrderflowHistory(orderflowHistory, {
      date: instrumentState[key].sessionDate,
      instrument: key,
      orderflow: instrumentState[key].fyersOrderflow
    });
    await persistOrderflowHistory();
    await updateTradeOutcomeJournal(key);
    if (endpoint === '/orderflow/volume-profile') saveCurrentSession(key);
    broadcast();
    response.json({ ok: true, instrument: key, endpoint, updatedAt: instrumentState[key].fyersOrderflow.updatedAt });
  } catch (error) {
    console.error('Could not process FYERS order-flow capture:', error.message);
    response.status(error instanceof TypeError ? 400 : 500).json({ ok: false, error: error.message });
  }
});