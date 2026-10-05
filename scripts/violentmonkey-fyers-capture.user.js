// ==UserScript==
// @name         Legend FYERS Orderflow Capture
// @namespace    https://legendv2-0.onrender.com/
// @version      1.1.0
// @description  Forward numeric FYERS orderflow responses to the Legend dashboard.
// @match        https://fyers.in/web/charts/orderflow*
// @match        https://trade.fyers.in/web/charts/orderflow*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      legendv2-0.onrender.com
// ==/UserScript==

(function () {
  'use strict';

  const captureUrl = 'https://legendv2-0.onrender.com/api/fyers-orderflow';
  const targetPaths = new Set(['/orderflow/footprint', '/orderflow/volume-profile']);
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  let forwarded = 0;

  function updateStatus(message, isError = false) {
    let status = document.getElementById('legend-fyers-capture-status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'legend-fyers-capture-status';
      status.style.cssText = [
        'position:fixed',
        'z-index:2147483647',
        'right:12px',
        'bottom:12px',
        'padding:8px 12px',
        'border-radius:6px',
        'background:#151922',
        'color:#dce4f2',
        'font:12px/1.4 sans-serif',
        'box-shadow:0 2px 12px #0008'
      ].join(';');
      (document.body || document.documentElement).appendChild(status);
    }
    status.textContent = `Legend capture · ${message}`;
    status.style.border = `1px solid ${isError ? '#f87171' : '#5ee0a0'}`;
  }

  function requestInfo(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return null;
    }
    if (!targetPaths.has(url.pathname)) return null;
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return null;
    return {
      symbol,
      endpoint: url.pathname,
      timeframe: url.searchParams.get('timeframe')
        || url.searchParams.get('resolution')
        || url.searchParams.get('interval')
        || (Number(url.searchParams.get('bar_seconds')) > 0
          ? String(Number(url.searchParams.get('bar_seconds')) / 60)
          : undefined)
    };
  }

  function forward(info, payload) {
    const token = GM_getValue('legendCaptureToken', '');
    if (!token) {
      updateStatus('open the Violentmonkey menu and set the Render capture token', true);
      return;
    }

    GM_xmlhttpRequest({
      method: 'POST',
      url: captureUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      data: JSON.stringify({ ...info, payload }),
      timeout: 10000,
      onload(response) {
        if (response.status < 200 || response.status >= 300) {
          updateStatus(`Render rejected capture (${response.status}); check the saved token`, true);
          return;
        }
        forwarded += 1;
        updateStatus(`${forwarded} response${forwarded === 1 ? '' : 's'} forwarded to dashboard`);
      },
      onerror() {
        updateStatus('could not reach Render; check the internet connection', true);
      },
      ontimeout() {
        updateStatus('Render request timed out', true);
      }
    });
  }

  const originalFetch = page.fetch;
  if (typeof originalFetch === 'function') {
    page.fetch = function (...args) {
      const result = originalFetch.apply(this, args);
      let info;
      try {
        const input = args[0];
        info = requestInfo(typeof input === 'string' ? input : input?.url);
      } catch {
        return result;
      }
      if (!info) return result;

      return result.then((response) => {
        if (response.ok) {
          response.clone().json()
            .then((payload) => forward(info, payload))
            .catch(() => updateStatus('could not read an Order Flow response', true));
        }
        return response;
      });
    };
  }

  const xhrPrototype = page.XMLHttpRequest?.prototype;
  if (xhrPrototype) {
    const originalOpen = xhrPrototype.open;
    const originalSend = xhrPrototype.send;
    xhrPrototype.open = function (method, url, ...rest) {
      this.__legendCaptureInfo = requestInfo(url);
      return originalOpen.call(this, method, url, ...rest);
    };
    xhrPrototype.send = function (...args) {
      const info = this.__legendCaptureInfo;
      if (info) {
        this.addEventListener('load', () => {
          if (this.status < 200 || this.status >= 300) return;
          try {
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            forward(info, payload);
          } catch {
            updateStatus('could not read an Order Flow response', true);
          }
        }, { once: true });
      }
      return originalSend.apply(this, args);
    };
  }

  GM_registerMenuCommand('Set Legend Render capture token', () => {
    const value = prompt('Paste the Render LEGEND_CAPTURE_TOKEN. It is stored in Violentmonkey, not in this script.');
    if (!value?.trim()) return;
    GM_setValue('legendCaptureToken', value.trim());
    updateStatus('token saved; reload the FYERS Order Flow chart to capture data');
  });

  updateStatus(GM_getValue('legendCaptureToken', '')
    ? 'ready; waiting for FYERS Order Flow responses'
    : 'set the Render token from the Violentmonkey menu', !GM_getValue('legendCaptureToken', ''));
})();
