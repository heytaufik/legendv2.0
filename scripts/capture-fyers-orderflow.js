import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const chromeCandidates = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
].filter(Boolean);
const executablePath = chromeCandidates.find(existsSync);

if (!executablePath) {
  console.error('Chrome not found. Set CHROME_PATH to chrome.exe and run again.');
  process.exit(1);
}

const captureUrl = process.env.LEGEND_CAPTURE_URL || `http://127.0.0.1:${Number(process.env.PORT || 3000)}/api/fyers-orderflow`;
const captureToken = process.env.LEGEND_CAPTURE_TOKEN || '';
const captureEndpoint = new URL(captureUrl);
const localCaptureHosts = new Set(['localhost', '127.0.0.1', '::1']);
const isLocalCapture = localCaptureHosts.has(captureEndpoint.hostname.replace(/^\[|\]$/g, ''));

if (!isLocalCapture && captureEndpoint.protocol !== 'https:') {
  throw new Error('Remote FYERS capture requires an HTTPS endpoint.');
}
if (!isLocalCapture && !captureToken) {
  throw new Error('Set LEGEND_CAPTURE_TOKEN before forwarding FYERS data to a remote server.');
}

const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'legend-fyers-capture-'));
const browser = await puppeteer.launch({
  executablePath,
  headless: false,
  userDataDir: profileDirectory,
  args: ['--no-first-run', '--no-default-browser-check']
});
const page = await browser.newPage();
let closing = false;

page.on('response', async (response) => {
  let url;
  try {
    url = new URL(response.url());
  } catch {
    return;
  }
  if (!/\/orderflow\/(footprint|volume-profile)$/i.test(url.pathname)) return;
  const symbol = url.searchParams.get('symbol');
  if (!response.ok() || !symbol) return;
  const requestedTimeframe = url.searchParams.get('timeframe')
    || url.searchParams.get('resolution')
    || url.searchParams.get('interval');
  try {
    const body = await response.json();
    const headers = { 'Content-Type': 'application/json' };
    if (captureToken) headers.Authorization = 'Bearer ' + captureToken;
    const result = await fetch(captureEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ symbol, endpoint: url.pathname, timeframe: requestedTimeframe, payload: body }),
      signal: AbortSignal.timeout(5000)
    });
    const acknowledgement = await result.json();
    console.log(`FYERS ${url.pathname}: ${result.ok ? 'forwarded' : 'rejected'} (${acknowledgement.instrument || acknowledgement.error || result.status})`);
  } catch (error) {
    console.error(`Could not forward FYERS ${url.pathname}: ${error.message}`);
  }
});

async function cleanup() {
  if (closing) return;
  closing = true;
  if (browser.connected) await browser.close();
  await rm(profileDirectory, { recursive: true, force: true });
}

process.once('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});

browser.on('disconnected', () => {
  void rm(profileDirectory, { recursive: true, force: true });
});

console.log(`A temporary Chrome profile is open. Log in manually, open the Order Flow chart, and change timeframes to capture data into ${captureUrl}.`);
console.log('No login details are saved. Press Ctrl+C to close Chrome and remove its temporary profile.');
await page.goto('https://fyers.in/web/charts/orderflow', { waitUntil: 'domcontentloaded' });