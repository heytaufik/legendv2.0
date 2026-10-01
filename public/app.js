const numberFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const instrumentButtons = [...document.querySelectorAll('.instrument-tabs button')];
let selectedSymbol = 'NIFTY';
let selectedTimeframe = 5;
let marketData = null;

function formatNumber(value) {
  return Number.isFinite(value) ? numberFormat.format(value) : '--';
}

function formatSigned(value, suffix = '') {
  if (!Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${numberFormat.format(value)}${suffix}`;
}

function setTone(element, value) {
  element.classList.toggle('positive', Number.isFinite(value) && value > 0);
  element.classList.toggle('negative', Number.isFinite(value) && value < 0);
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp));
}

function renderFlow(flow = []) {
  const bars = document.getElementById('bars');
  const axis = document.getElementById('flow-axis');
  bars.replaceChildren();
  axis.replaceChildren();
  const maxDelta = Math.max(1, ...flow.map((bucket) => Math.abs(bucket.delta)));
  flow.forEach((bucket) => {
    const bar = document.createElement('span');
    bar.classList.toggle('down', bucket.delta < 0);
    bar.style.height = `${bucket.delta ? Math.max(3, Math.abs(bucket.delta) / maxDelta * 100) : 0}%`;
    bars.append(bar);
  });
  if (flow.length) {
    [flow[0], flow[Math.floor((flow.length - 1) / 2)], flow.at(-1)].forEach((bucket) => {
      const label = document.createElement('span');
      label.textContent = formatTime(bucket.time);
      axis.append(label);
    });
  }
}

function renderProfile(instrument, profileId = 'profile') {
  const profile = document.getElementById(profileId);
  profile.replaceChildren();
  const levels = [...(instrument.profile || [])].reverse();
  if (!levels.length) {
    const empty = document.createElement('div');
    empty.className = 'profile-empty';
    empty.textContent = 'Waiting for session volume';
    profile.append(empty);
    return;
  }
  const maxVolume = Math.max(1, ...levels.map((level) => level.volume));
  levels.forEach((level) => {
    const row = document.createElement('div');
    row.className = 'profile-row';
    if (level.inValueArea) row.classList.add('in-value-area');
    if (level.isVah) row.classList.add('is-vah');
    if (level.isVal) row.classList.add('is-val');
    if (level.isPoc) row.classList.add('is-poc');
    if (level.isDayLow) row.classList.add('is-day-low');
    if (level.isLvn) row.classList.add('is-lvn');
    row.title = `${formatNumber(level.price)}: ${formatNumber(level.volume)} contracts`;

    const price = document.createElement('span');
    price.className = 'profile-price';
    price.textContent = formatNumber(level.price);
    row.append(price);

    const track = document.createElement('span');
    track.className = 'profile-track';
    const bar = document.createElement('span');
    bar.className = 'profile-volume';
    bar.style.width = `${level.volume ? Math.max(1, level.volume / maxVolume * 100) : 0}%`;
    track.append(bar);
    row.append(track);

    const tags = document.createElement('span');
    tags.className = 'profile-tags';
    if (level.isVah) tags.append(makeProfileTag('VAH', 'tag-value'));
    if (level.isVal) tags.append(makeProfileTag('VAL', 'tag-value'));
    if (level.isPoc) tags.append(makeProfileTag('POC', 'tag-poc'));
    if (level.isDayLow) tags.append(makeProfileTag('LOW', 'tag-low'));
    if (level.isLvn) tags.append(makeProfileTag('LVN', 'tag-lvn'));
    row.append(tags);
    profile.append(row);
  });
}

function makeProfileTag(text, className) {
  const tag = document.createElement('span');
  tag.className = className;
  tag.textContent = text;
  return tag;
}

function updateProfile(instrument, prefix = '') {
  document.getElementById(`${prefix}vah`).textContent = formatNumber(instrument.vah);
  document.getElementById(`${prefix}poc`).textContent = formatNumber(instrument.poc);
  document.getElementById(`${prefix}val`).textContent = formatNumber(instrument.val);
  document.getElementById(`${prefix}profile-low`).textContent = formatNumber(instrument.low);
  document.getElementById(`${prefix}${prefix ? 'lvns' : 'lvn-summary'}`).textContent = instrument.lvns?.length
    ? instrument.lvns.map(formatNumber).join(' / ')
    : '--';
  document.getElementById(`${prefix}profile-status`).textContent = instrument.poc === null ? 'COLLECTING' : 'LIVE';
  renderProfile(instrument, `${prefix}profile` || 'profile');
}

function setupCanvas(id, height) {
  const canvas = document.getElementById(id);
  const width = canvas.clientWidth;
  if (!width) return null;
  const scale = window.devicePixelRatio || 1;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  return { canvas, context, width, height };
}

function drawEmptyCanvas(id, height, message) {
  const chart = setupCanvas(id, height);
  if (!chart) return;
  chart.context.fillStyle = '#8a9691';
  chart.context.font = '11px "Space Mono", monospace';
  chart.context.textAlign = 'center';
  chart.context.fillText(message, chart.width / 2, chart.height / 2);
}

function chartCanvasHeight(viewportRatio, minimum, maximum) {
  const viewportLimit = window.innerWidth <= 600 ? Math.min(maximum, 420) : maximum;
  return Math.round(Math.min(viewportLimit, Math.max(minimum, window.innerHeight * viewportRatio)));
}

function drawPriceChart(bars) {
  const height = chartCanvasHeight(0.5, 340, 640);
  const chart = setupCanvas('orderflow-candles', height);
  if (!chart) return;
  if (!bars.length) {
    drawEmptyCanvas('orderflow-candles', height, 'Waiting for traded ticks');
    return;
  }
  const { context, width, height: canvasHeight } = chart;
  const margin = { left: 58, right: 12, top: 12, bottom: 24 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = canvasHeight - margin.top - margin.bottom;
  const minimum = Math.min(...bars.map((bar) => bar.low));
  const maximum = Math.max(...bars.map((bar) => bar.high));
  const padding = maximum === minimum ? Math.max(1, maximum * 0.0005) : (maximum - minimum) * 0.08;
  const lower = minimum - padding;
  const upper = maximum + padding;
  const y = (price) => margin.top + (upper - price) / (upper - lower) * plotHeight;

  context.font = '9px "Space Mono", monospace';
  context.textAlign = 'right';
  for (let index = 0; index <= 4; index += 1) {
    const price = upper - (upper - lower) * index / 4;
    const yPosition = margin.top + plotHeight * index / 4;
    context.strokeStyle = '#29312f';
    context.beginPath();
    context.moveTo(margin.left, yPosition);
    context.lineTo(width - margin.right, yPosition);
    context.stroke();
    context.fillStyle = '#8a9691';
    context.fillText(formatNumber(price), margin.left - 7, yPosition + 3);
  }

  const slotWidth = plotWidth / bars.length;
  const bodyWidth = Math.max(2, Math.min(9, slotWidth * 0.62));
  bars.forEach((bar, index) => {
    const center = margin.left + slotWidth * (index + 0.5);
    const rising = bar.close >= bar.open;
    const color = rising ? '#57d39a' : '#f07f83';
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(center, y(bar.high));
    context.lineTo(center, y(bar.low));
    context.stroke();
    const bodyTop = Math.min(y(bar.open), y(bar.close));
    const bodyHeight = Math.max(1.5, Math.abs(y(bar.open) - y(bar.close)));
    context.fillRect(center - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  });
}

function drawDeltaChart(bars) {
  const height = chartCanvasHeight(0.17, 132, 220);
  const chart = setupCanvas('delta-chart', height);
  if (!chart) return;
  if (!bars.length) {
    drawEmptyCanvas('delta-chart', height, 'Delta will appear with the first volume update');
    return;
  }
  const { context, width, height: canvasHeight } = chart;
  const margin = { left: 58, right: 12, top: 10, bottom: 10 };
  const plotWidth = width - margin.left - margin.right;
  const baseline = margin.top + (canvasHeight - margin.top - margin.bottom) / 2;
  const maxDelta = Math.max(1, ...bars.map((bar) => Math.abs(bar.delta)));
  context.strokeStyle = '#48544f';
  context.beginPath();
  context.moveTo(margin.left, baseline);
  context.lineTo(width - margin.right, baseline);
  context.stroke();
  context.fillStyle = '#8a9691';
  context.font = '9px "Space Mono", monospace';
  context.textAlign = 'right';
  context.fillText('0', margin.left - 7, baseline + 3);
  const slotWidth = plotWidth / bars.length;
  const barWidth = Math.max(1, Math.min(9, slotWidth * 0.65));
  bars.forEach((bar, index) => {
    const barHeight = Math.abs(bar.delta) / maxDelta * (baseline - margin.top - 2);
    context.fillStyle = bar.delta >= 0 ? '#57d39a' : '#f07f83';
    context.fillRect(margin.left + slotWidth * (index + 0.5) - barWidth / 2, bar.delta >= 0 ? baseline - barHeight : baseline, barWidth, Math.max(bar.delta ? 1 : 0, barHeight));
  });
}

function drawCvdChart(bars) {
  const height = chartCanvasHeight(0.2, 156, 240);
  const chart = setupCanvas('cvd-chart', height);
  if (!chart) return;
  if (!bars.length) {
    drawEmptyCanvas('cvd-chart', height, 'CVD will appear with the first volume update');
    return;
  }
  const { context, width, height: canvasHeight } = chart;
  const margin = { left: 58, right: 12, top: 12, bottom: 25 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = canvasHeight - margin.top - margin.bottom;
  const values = bars.map((bar) => bar.cvd);
  let minimum = Math.min(0, ...values);
  let maximum = Math.max(0, ...values);
  if (minimum === maximum) {
    minimum -= 1;
    maximum += 1;
  }
  const y = (value) => margin.top + (maximum - value) / (maximum - minimum) * plotHeight;
  context.font = '9px "Space Mono", monospace';
  context.textAlign = 'right';
  for (let index = 0; index <= 2; index += 1) {
    const value = maximum - (maximum - minimum) * index / 2;
    const yPosition = y(value);
    context.strokeStyle = '#29312f';
    context.beginPath();
    context.moveTo(margin.left, yPosition);
    context.lineTo(width - margin.right, yPosition);
    context.stroke();
    context.fillStyle = '#8a9691';
    context.fillText(formatNumber(value), margin.left - 7, yPosition + 3);
  }
  const step = bars.length > 1 ? plotWidth / (bars.length - 1) : 0;
  context.strokeStyle = '#62b7ff';
  context.lineWidth = 1.5;
  context.beginPath();
  bars.forEach((bar, index) => {
    const x = bars.length > 1 ? margin.left + step * index : margin.left + plotWidth / 2;
    if (index === 0) context.moveTo(x, y(bar.cvd));
    else context.lineTo(x, y(bar.cvd));
  });
  context.stroke();
  context.fillStyle = '#8a9691';
  context.textAlign = 'left';
  context.fillText(formatTime(bars[0].time), margin.left, canvasHeight - 5);
  context.textAlign = 'right';
  context.fillText(formatTime(bars.at(-1).time), width - margin.right, canvasHeight - 5);
}

function renderOrderflow(instrument) {
  document.getElementById('chart-instrument-title').textContent = instrument.symbol || `${selectedSymbol} FUTURES`;
  const bars = instrument.orderflow?.[selectedTimeframe] || [];
  const candle = bars.at(-1);
  const values = { open: candle?.open, high: candle?.high, low: candle?.low, close: candle?.close, volume: candle?.volume };
  for (const [field, value] of Object.entries(values)) {
    document.getElementById(`chart-${field}`).textContent = formatNumber(value);
  }
  const delta = document.getElementById('chart-delta');
  delta.textContent = candle ? formatSigned(candle.delta) : '--';
  setTone(delta, candle?.delta);
  const cvd = document.getElementById('chart-cvd');
  cvd.textContent = candle ? formatSigned(candle.cvd) : '--';
  setTone(cvd, candle?.cvd);
  document.getElementById('chart-status').textContent = bars.length ? `${bars.length} ${selectedTimeframe}m bars` : 'WAITING FOR TICKS';
  drawPriceChart(bars.slice(-80));
  drawDeltaChart(bars.slice(-80));
  drawCvdChart(bars.slice(-80));
}

function renderOpeningConviction(instrument) {
  const conviction = instrument.openingConviction || {};
  const labels = {
    UP: 'SHIFTED UP',
    DOWN: 'SHIFTED DOWN',
    INSIDE: 'INSIDE VALUE',
    WAITING_OPEN: 'WAITING FOR OPEN',
    WAITING_PRIOR_VALUE: 'NO PRIOR VALUE'
  };
  const status = labels[conviction.direction] || 'WAITING';
  const comparison = conviction.direction === 'UP'
    ? `Open ${formatNumber(conviction.open)} > prior VAH ${formatNumber(conviction.previousVah)}`
    : conviction.direction === 'DOWN'
      ? `Open ${formatNumber(conviction.open)} < prior VAL ${formatNumber(conviction.previousVal)}`
      : conviction.direction === 'INSIDE'
        ? `Open ${formatNumber(conviction.open)} inside ${formatNumber(conviction.previousVal)} to ${formatNumber(conviction.previousVah)}`
        : '--';
  const reference = conviction.previousDate
    ? `${conviction.previousDate} | VAH ${formatNumber(conviction.previousVah)} | VAL ${formatNumber(conviction.previousVal)}`
    : 'No saved prior session value area';

  for (const id of ['opening-status', 'chart-opening-status']) {
    const element = document.getElementById(id);
    element.textContent = status;
    element.dataset.bias = conviction.direction || 'waiting';
  }
  document.getElementById('opening-comparison').textContent = comparison;
  document.getElementById('opening-reference').textContent = reference;
}

function updateInstrument() {
  if (!marketData) return;
  const instrument = marketData.instruments?.[selectedSymbol];
  if (!instrument) return;

  document.getElementById('symbol-label').textContent = instrument.symbol || `${selectedSymbol} FUTURES`;
  document.getElementById('ltp').textContent = formatNumber(instrument.price);
  const changeText = Number.isFinite(instrument.change)
    ? `${formatSigned(instrument.change)} (${formatSigned(instrument.changePercent, '%')})`
    : '--';
  const change = document.getElementById('change');
  change.textContent = changeText;
  setTone(change, instrument.change);

  document.getElementById('open').textContent = formatNumber(instrument.open);
  document.getElementById('high').textContent = formatNumber(instrument.high);
  document.getElementById('low').textContent = formatNumber(instrument.low);
  const delta = document.getElementById('delta');
  delta.textContent = instrument.updatedAt ? formatSigned(instrument.delta) : '--';
  setTone(delta, instrument.delta);
  const cvd = document.getElementById('cvd');
  cvd.textContent = instrument.updatedAt ? formatSigned(instrument.cvd) : '--';
  setTone(cvd, instrument.cvd);

  updateProfile(instrument);
  updateProfile(instrument, 'chart-');
  renderOpeningConviction(instrument);
  renderFlow(instrument.flow);
  renderOrderflow(instrument);
}

function updateConnection(state) {
  const status = document.getElementById('feed-status-wrap');
  const label = document.getElementById('feed-status');
  const message = document.getElementById('feed-message');
  status.dataset.state = state.status;
  label.textContent = state.status === 'connected'
    ? 'LIVE TICKS'
    : state.status === 'connecting' ? 'CONNECTING' : 'DISCONNECTED';
  message.textContent = state.message;
}

function selectSymbol(symbol) {
  selectedSymbol = symbol;
  document.querySelectorAll('[data-symbol], [data-chart-symbol]').forEach((button) => {
    button.classList.toggle('active', button.dataset.symbol === symbol || button.dataset.chartSymbol === symbol);
  });
  updateInstrument();
}

instrumentButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectSymbol(button.dataset.symbol);
  });
});

document.querySelectorAll('[data-chart-symbol]').forEach((button) => {
  button.addEventListener('click', () => selectSymbol(button.dataset.chartSymbol));
});

document.querySelectorAll('[data-timeframe]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedTimeframe = Number(button.dataset.timeframe);
    document.querySelectorAll('[data-timeframe]').forEach((item) => item.classList.toggle('active', item === button));
    updateInstrument();
  });
});

const orderflowView = document.getElementById('orderflow-view');
document.getElementById('chart-toggle').addEventListener('click', (event) => {
  const opening = orderflowView.hidden;
  orderflowView.hidden = !opening;
  document.querySelectorAll('[data-overview]').forEach((section) => { section.hidden = opening; });
  event.currentTarget.textContent = opening ? 'Back to Overview' : 'See Orderflow Chart';
  if (opening) updateInstrument();
});

window.addEventListener('resize', () => {
  if (!orderflowView.hidden) updateInstrument();
});

const stream = new EventSource('/api/market-stream');
stream.addEventListener('message', (event) => {
  marketData = JSON.parse(event.data);
  updateConnection(marketData);
  updateInstrument();
});
stream.addEventListener('error', () => {
  document.getElementById('feed-status-wrap').dataset.state = 'disconnected';
  document.getElementById('feed-status').textContent = 'SERVER OFFLINE';
  document.getElementById('feed-message').textContent = 'Market server connection lost.';
});

function updateClock() {
  document.getElementById('session-time').textContent = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
}

updateClock();
setInterval(updateClock, 1000);