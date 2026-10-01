import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fyersSdk from 'fyers-api-v3';
import { parse } from 'csv-parse/sync';
import { calculateValueArea, classifyOpening, indiaDateKey, latestSessionBefore, pruneSessions, readSessionArchive, writeSessionArchive } from './lib/session-profile.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const directory = path.dirname(fileURLToPath(import.meta.url));
const archivePath = path.join(directory, 'data', 'session-profiles.json');
const { fyersDataSocket } = fyersSdk;
const configuredInstruments = {
  NIFTY: process.env.FYERS_NIFTY_SYMBOL || '',
  SENSEX: process.env.FYERS_SENSEX_SYMBOL || ''
};
const instrumentTickSizes = { NIFTY: 0.05, SENSEX: 0.05 };
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
  flow: [],
  orderflow: { 1: [], 3: [], 5: [], 15: [] },
  profile: new Map(),
  updatedAt: null
}]));
const streamClients = new Set();
let accessToken = '';
let marketSocket = null;
let connectionStatus = 'disconnected';
let connectionMessage = 'Loading active futures contracts from FYERS...';
let sessionArchive = {};
let archiveSaveTimer = null;
let archiveWriteQueue = Promise.resolve();

app.use(express.json());
app.use(express.static(path.join(directory, 'public')));

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

function scheduleArchiveSave() {
  if (archiveSaveTimer) return;
  archiveSaveTimer = setTimeout(() => {
    archiveSaveTimer = null;
    const archiveToWrite = structuredClone(sessionArchive);
    archiveWriteQueue = archiveWriteQueue
      .then(() => writeSessionArchive(archivePath, archiveToWrite))
      .catch((error) => console.error('Could not persist session profiles:', error.message));
  }, 1000);
  archiveSaveTimer.unref();
}

function previousSessionFor(instrument, beforeDate = indiaDateKey()) {
  return latestSessionBefore(sessionArchive, instrument, beforeDate);
}

function saveCurrentSession(instrument) {
  const state = instrumentState[instrument];
  const date = state.sessionDate;
  const valueArea = calculateValueArea(state.profile.entries());
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
    profile: Object.fromEntries(state.profile),
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
  if (saved) {
    state.open = saved.open ?? null;
    state.high = saved.high ?? null;
    state.low = saved.low ?? null;
    state.price = saved.close ?? null;
  }
}

async function loadSessionArchive() {
  try {
    sessionArchive = await readSessionArchive(archivePath);
  } catch (error) {
    console.error('Could not load saved session profiles:', error.message);
  }
  const today = indiaDateKey();
  for (const instrument of Object.keys(instrumentState)) restoreSession(instrument, today);
}

function resetForNewSession(instrument, date) {
  const state = instrumentState[instrument];
  state.previousClose = null;
  state.previousPrice = null;
  state.previousVolume = null;
  state.lastDirection = 0;
  state.delta = 0;
  state.cvd = 0;
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
    const valueArea = calculateValueArea(state.profile.entries());
    const priorSession = previousSessionFor(key, state.sessionDate);
    const openingDirection = classifyOpening(state.open, priorSession);
    const firstFlowBucket = Math.floor(Date.now() / 300000) * 300000 - 11 * 300000;
    const flowBuckets = Array.from({ length: 12 }, (_, index) => ({ time: firstFlowBucket + index * 300000, delta: 0 }));
    for (const tick of state.flow) {
      const index = Math.floor((tick.time - firstFlowBucket) / 300000);
      if (index >= 0 && index < flowBuckets.length) flowBuckets[index].delta += tick.delta;
    }
    let profile = [];
    let lvns = [];
    if (state.profile.size) {
      const tickSize = instrumentTickSizes[key] || 0.05;
      const tradedPrices = [...state.profile.keys()];
      const minimumPrice = Math.min(...tradedPrices, state.low ?? Infinity);
      const maximumPrice = Math.max(...tradedPrices, state.high ?? -Infinity);
      const bucketTicks = Math.max(1, Math.ceil((maximumPrice - minimumPrice) / (tickSize * 60)));
      const bucketSize = bucketTicks * tickSize;
      const minimumBucket = Math.floor(minimumPrice / bucketSize);
      const maximumBucket = Math.floor(maximumPrice / bucketSize);
      const volumes = new Map();
      for (const [price, volume] of state.profile) {
        const bucket = Math.floor(price / bucketSize);
        volumes.set(bucket, (volumes.get(bucket) || 0) + volume);
      }
      profile = Array.from({ length: maximumBucket - minimumBucket + 1 }, (_, index) => {
        const bucket = minimumBucket + index;
        const price = Number((bucket * bucketSize).toFixed(8));
        return { price, volume: volumes.get(bucket) || 0 };
      });
      const lvnIndices = [];
      for (let index = 1; index < profile.length - 1; index += 1) {
        const current = profile[index].volume;
        const neighborThreshold = Math.min(profile[index - 1].volume, profile[index + 1].volume) * 0.5;
        if (current > 0 && current < neighborThreshold) lvnIndices.push(index);
      }
      lvns = lvnIndices.map((index) => profile[index].price);
      profile.forEach((level, index) => {
        const bucket = Math.floor(level.price / bucketSize);
        level.isVah = valueArea.vah !== null && bucket === Math.floor(valueArea.vah / bucketSize);
        level.isVal = valueArea.val !== null && bucket === Math.floor(valueArea.val / bucketSize);
        level.isPoc = valueArea.poc !== null && bucket === Math.floor(valueArea.poc / bucketSize);
        level.inValueArea = valueArea.val !== null && level.price <= valueArea.vah && level.price + bucketSize > valueArea.val;
        level.isLvn = lvnIndices.includes(index);
        level.isDayLow = state.low !== null && bucket === Math.floor(state.low / bucketSize);
      });
    }
    instruments[key] = {
      symbol,
      configured: Boolean(symbol),
      sessionDate: state.sessionDate,
      price: state.price,
      change: state.price !== null && state.previousClose !== null ? state.price - state.previousClose : null,
      changePercent: state.price !== null && state.previousClose ? ((state.price - state.previousClose) / state.previousClose) * 100 : null,
      open: state.open,
      high: state.high,
      low: state.low,
      delta: state.flow.filter((tick) => tick.time >= Date.now() - 5 * 60 * 1000).reduce((total, tick) => total + tick.delta, 0),
      cvd: state.cvd,
      flow: state.flow.length ? flowBuckets : [],
      orderflow: state.orderflow,
      profile,
      lvns,
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

async function loadActiveFutures() {
  const masters = [
    { key: 'NIFTY', url: 'https://public.fyers.in/sym_details/NSE_FO.csv', pattern: /^NIFTY\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{2}\s+FUT$/i },
    { key: 'SENSEX', url: 'https://public.fyers.in/sym_details/BSE_FO.csv', pattern: /^SENSEX\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{2}\s+FUT$/i }
  ];
  const results = await Promise.allSettled(masters.map(async ({ key, url, pattern }) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`FYERS symbol master returned ${response.status}`);
    const records = parse(await response.text(), { skip_empty_lines: true, relax_column_count: true });
    const contracts = records
      .filter((record) => pattern.test(String(record[1] || '').trim()) && Number(record[8]) * 1000 > Date.now())
      .sort((a, b) => Number(a[8]) - Number(b[8]));
    const contract = contracts[0];
    if (!contract) throw new Error(`No active ${key} futures contract found`);
    if (!configuredInstruments[key]) configuredInstruments[key] = String(contract[9]).trim();
    instrumentTickSizes[key] = numberOrNull(contract[4]) || instrumentTickSizes[key];
  }));
  const failed = results.filter((result) => result.status === 'rejected');
  connectionMessage = failed.length
    ? 'Could not load all active futures contracts. Check the server network connection.'
    : 'Connect FYERS to start live market data.';
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
    marketSocket.on('connect', () => {
      connectionStatus = 'connected';
      connectionMessage = 'Live FYERS feed connected. Delta uses tick-rule estimation.';
      marketSocket.subscribe(symbols);
      broadcast();
    });
    marketSocket.on('message', handleMarketMessage);
    marketSocket.on('error', () => {
      connectionStatus = 'disconnected';
      connectionMessage = 'FYERS market feed error. Reconnect to try again.';
      broadcast();
    });
    marketSocket.on('close', () => {
      connectionStatus = 'disconnected';
      connectionMessage = 'FYERS market feed closed.';
      broadcast();
    });
    marketSocket.connect();
  } catch {
    connectionStatus = 'disconnected';
    connectionMessage = 'Could not start the FYERS market feed.';
    broadcast();
  }
}

app.post('/webhook', (request, response) => {
  console.log('FYERS webhook received:', request.body?.type || 'order update');
  response.sendStatus(200);
});

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    mode: snapshot().mode,
    trading: false,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/market-state', (_request, response) => {
  response.json(snapshot());
});

app.get('/api/market-stream', (request, response) => {
  response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  response.flushHeaders();
  response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  streamClients.add(response);
  request.on('close', () => streamClients.delete(response));
});

await loadSessionArchive();

loadActiveFutures().catch(() => {
  connectionMessage = 'Could not load active futures contracts from FYERS.';
  broadcast();
});

app.listen(port, () => {
  console.log(`Market dashboard running at http://localhost:${port}`);
});