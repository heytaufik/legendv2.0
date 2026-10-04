import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const userscript = await readFile(new URL('../scripts/violentmonkey-fyers-capture.user.js', import.meta.url), 'utf8');

function runUserscript({ token = 'test-capture-token' } = {}) {
  const requests = [];
  const menuCommands = [];
  const statusElement = { style: {}, textContent: '' };
  const documentElement = { appendChild() {} };
  const page = {
    fetch: async () => ({
      ok: true,
      clone: () => ({ json: async () => ({ candles: [{ time: 123 }] }) })
    })
  };
  const context = {
    URL,
    location: { href: 'https://fyers.in/web/charts/orderflow' },
    document: {
      body: null,
      documentElement,
      getElementById: () => statusElement,
      createElement: () => statusElement
    },
    unsafeWindow: page,
    GM_getValue: (_key, fallback) => token || fallback,
    GM_setValue() {},
    GM_registerMenuCommand: (name, callback) => menuCommands.push({ name, callback }),
    GM_xmlhttpRequest: (request) => {
      requests.push(request);
      request.onload({ status: 200 });
    }
  };

  vm.runInNewContext(userscript, context);
  return { page, requests, menuCommands, statusElement };
}

test('forwards matching FYERS fetch responses to the authenticated Render endpoint', async () => {
  const { page, requests, statusElement } = runUserscript();
  await page.fetch('https://fyers.in/orderflow/footprint?symbol=NSE%3ANIFTY26OCTFUT&timeframe=5');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://legendv2-0.onrender.com/api/fyers-orderflow');
  assert.equal(requests[0].headers.Authorization, 'Bearer test-capture-token');
  assert.deepEqual(JSON.parse(requests[0].data), {
    symbol: 'NSE:NIFTY26OCTFUT',
    endpoint: '/orderflow/footprint',
    timeframe: '5',
    payload: { candles: [{ time: 123 }] }
  });
  assert.match(statusElement.textContent, /1 response forwarded/);
});

test('ignores unrelated FYERS fetches', async () => {
  const { page, requests } = runUserscript();
  await page.fetch('https://fyers.in/api/quotes?symbol=NSE%3ANIFTY26OCTFUT');
  assert.equal(requests.length, 0);
});

test('offers token setup through the extension menu without embedding a token in the userscript', () => {
  const { menuCommands } = runUserscript({ token: '' });
  assert.equal(menuCommands.length, 1);
  assert.equal(menuCommands[0].name, 'Set Legend Render capture token');
  assert.doesNotMatch(userscript, /test-capture-token/);
});
