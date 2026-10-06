const numberFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const instrumentButtons = [...document.querySelectorAll('.instrument-tabs button')];
let selectedSymbol = 'NIFTY';
let selectedTimeframe = 5;
let marketData = null;
let activeView = 'overview';

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

function formatFootprintDateTime(timestamp) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp));
}

function formatSessionDate(date) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata'
  }).format(new Date(`${date}T12:00:00+05:30`));
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

function renderOverviewCapture(instrument) {
  const capture = instrument.fyersOrderflow;
  const state = document.getElementById('overview-capture-state');
  const detail = document.getElementById('overview-capture-detail');
  const candles = capture?.candles || {};
  const capturedCandles = Object.values(candles).flat();
  const hasProfile = Boolean(capture?.profile?.length);
  const hasCapture = capturedCandles.length > 0 || hasProfile;
  const freshTimeframes = Object.entries(capture?.candleFresh || {})
    .filter(([, fresh]) => fresh)
    .map(([timeframe]) => timeframe);
  const isLive = Boolean(capture?.profileFresh || freshTimeframes.length);
  const latestCapture = [
    capture?.footprintUpdatedAt,
    capture?.profileUpdatedAt,
    ...Object.values(capture?.candleUpdatedAt || {})
  ].map((time) => Date.parse(time)).filter(Number.isFinite).sort((left, right) => right - left)[0];

  state.dataset.state = !hasCapture ? 'empty' : isLive ? 'live' : 'saved';
  state.textContent = !hasCapture
    ? 'NO ORDERFLOW CAPTURE'
    : isLive ? 'REAL FYERS CAPTURE · LIVE' : 'FYERS CAPTURE · SAVED';
  if (!hasCapture) {
    detail.textContent = `FYERS Order Flow page par Violentmonkey ka "Legend capture" badge dekho. Wahan "responses forwarded" aana chahiye; badge na ho to userscript enable karo, token set karke page reload karo. LIVE TICKS alag feed hai.`;
    return;
  }

  const timeframes = Object.keys(candles)
    .filter((timeframe) => candles[timeframe]?.length)
    .sort((left, right) => Number(left) - Number(right))
    .map((timeframe) => `${timeframe}m`);
  const sources = [
    timeframes.length ? `${timeframes.join('/')} footprint candles` : '',
    hasProfile ? `${capture.profile.length} session profile prices` : ''
  ].filter(Boolean).join(' · ');
  detail.textContent = `${capture.symbol || instrument.symbol || selectedSymbol} · ${sources}${latestCapture ? ` · last capture ${formatFootprintDateTime(latestCapture)} IST` : ''}${!isLive ? ' · waiting for next live capture' : ''}`;
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

function renderLvnZones(instrument) {
  const sections = [
    { id: 'today-lvn-zones', countId: 'today-lvn-count', zones: instrument.todayLvnZones || [], historical: false },
    { id: 'historical-lvn-zones', countId: 'historical-lvn-count', zones: instrument.historicalLvnZones || [], historical: true }
  ];
  for (const section of sections) {
    const list = document.getElementById(section.id);
    list.replaceChildren();
    document.getElementById(section.countId).textContent = String(section.zones.length);
    if (!section.zones.length) {
      const empty = document.createElement('div');
      empty.className = 'lvn-zone-empty';
      empty.textContent = section.historical ? 'No untested prior areas' : 'No LVN areas detected';
      list.append(empty);
      continue;
    }
    section.zones.forEach((zone) => {
      const row = document.createElement('div');
      row.className = 'lvn-zone-row';
      const range = document.createElement('strong');
      range.className = 'lvn-zone-range';
      range.textContent = `${formatNumber(zone.low)} - ${formatNumber(zone.high)}`;
      const meta = document.createElement('span');
      meta.className = 'lvn-zone-meta';
      meta.textContent = section.historical
        ? `${formatSessionDate(zone.date)} · ${formatNumber(zone.volume)} volume · ${zone.source === 'FYERS_CHART' ? 'FYERS' : 'estimated'}`
        : `${formatSessionDate(zone.date)} · ${formatNumber(zone.volume)} volume · ${zone.source === 'FYERS_CHART' ? 'FYERS' : 'estimated'}`;
      const status = document.createElement('span');
      status.className = `lvn-zone-status ${zone.valueAreaStatus.toLowerCase()}`;
      status.textContent = section.historical ? `UNTESTED · ${zone.valueAreaStatus} VA` : `${zone.valueAreaStatus} VA`;
      row.append(range, meta, status);
      list.append(row);
    });
  }
}

function updateProfile(instrument, prefix = '') {
  document.getElementById(`${prefix}vah`).textContent = formatNumber(instrument.vah);
  document.getElementById(`${prefix}poc`).textContent = formatNumber(instrument.poc);
  document.getElementById(`${prefix}val`).textContent = formatNumber(instrument.val);
  document.getElementById(`${prefix}profile-low`).textContent = formatNumber(instrument.low);
  const zones = instrument.todayLvnZones || [];
  document.getElementById(`${prefix}${prefix ? 'lvns' : 'lvn-summary'}`).textContent = zones.length
    ? zones.slice(0, 3).map((zone) => `${formatNumber(zone.low)}-${formatNumber(zone.high)}`).join(' / ')
    : '--';
  document.getElementById(`${prefix}profile-status`).textContent = instrument.poc === null
    ? 'COLLECTING'
    : instrument.profileSource === 'FYERS_CHART' ? 'FYERS' : 'LIVE';
  renderProfile(instrument, `${prefix}profile` || 'profile');
  if (!prefix) renderLvnZones(instrument);
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

function drawPriceChart(bars, emptyMessage) {
  const height = chartCanvasHeight(0.5, 340, 640);
  const chart = setupCanvas('orderflow-candles', height);
  if (!chart) return;
  if (!bars.length) {
    drawEmptyCanvas('orderflow-candles', height, emptyMessage);
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

function drawDeltaChart(bars, emptyMessage) {
  const height = chartCanvasHeight(0.17, 132, 220);
  const chart = setupCanvas('delta-chart', height);
  if (!chart) return;
  if (!bars.length) {
    drawEmptyCanvas('delta-chart', height, emptyMessage);
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

function drawCvdChart(bars, emptyMessage) {
  const height = chartCanvasHeight(0.2, 156, 240);
  const chart = setupCanvas('cvd-chart', height);
  if (!chart) return;
  if (!bars.length) {
    drawEmptyCanvas('cvd-chart', height, emptyMessage);
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

function renderFyersCapture(instrument) {
  const capture = instrument.fyersOrderflow;
  const status = document.getElementById('capture-status');
  const levelsContainer = document.getElementById('capture-levels');
  const candles = capture?.candles?.[selectedTimeframe] || capture?.candles?.[String(selectedTimeframe)] || [];
  const candle = candles.at(-1);
  const profile = capture?.profile || [];
  const candleFresh = Boolean(capture?.candleFresh?.[selectedTimeframe] || capture?.candleFresh?.[String(selectedTimeframe)]);
  const profileFresh = Boolean(capture?.profileFresh);
  const hasCapture = Boolean(candle || profile.length);

  status.textContent = !hasCapture ? 'NO CAPTURE' : candleFresh || profileFresh ? 'FYERS · LIVE' : 'FYERS · SAVED';
  status.dataset.state = !hasCapture ? 'empty' : candleFresh || profileFresh ? 'live' : 'saved';
  document.getElementById('capture-data-source').textContent = hasCapture
    ? `${capture.symbol} · captured from FYERS Order Flow`
    : `Waiting for FYERS Order Flow capture for ${capture?.symbol || instrument.symbol}`;
  document.getElementById('capture-candle-time').textContent = candle
    ? `${selectedTimeframe}m · ${formatTime(candle.time)} IST`
    : '--';
  document.getElementById('capture-ohlc').textContent = candle
    ? `${formatNumber(candle.open)} / ${formatNumber(candle.high)} / ${formatNumber(candle.low)} / ${formatNumber(candle.close)}`
    : '--';
  document.getElementById('capture-ask-volume').textContent = candle ? formatNumber(candle.positiveVolume) : '--';
  document.getElementById('capture-bid-volume').textContent = candle ? formatNumber(candle.negativeVolume) : '--';
  document.getElementById('capture-delta').textContent = candle ? formatSigned(candle.delta) : '--';
  document.getElementById('capture-cvd').textContent = candle ? formatSigned(candle.cvd) : formatSigned(capture?.cvd);
  document.getElementById('capture-profile-count').textContent = profile.length
    ? `${profile.length} prices · ${formatNumber(capture.valueArea?.totalVolume)} volume`
    : '--';

  levelsContainer.replaceChildren();
  const levels = [...(candle?.levels || [])].sort((left, right) => right.price - left.price);
  if (!levels.length) {
    const empty = document.createElement('div');
    empty.className = 'footprint-empty';
    empty.textContent = hasCapture
      ? 'This capture has no per-price footprint levels.'
      : 'Waiting for a FYERS footprint capture. No estimated Bid/Ask data is shown here.';
    levelsContainer.append(empty);
    return;
  }

  levels.forEach((level) => {
    const row = document.createElement('div');
    row.className = 'footprint-row';
    row.setAttribute('role', 'row');
    const delta = level.positiveVolume - level.negativeVolume;
    [
      formatNumber(level.price),
      formatNumber(level.negativeVolume),
      formatNumber(level.positiveVolume),
      formatSigned(delta)
    ].forEach((value, index) => {
      const cell = document.createElement('span');
      cell.textContent = value;
      cell.setAttribute('role', 'cell');
      if (index === 3) cell.classList.toggle(delta >= 0 ? 'positive' : 'negative', true);
      row.append(cell);
    });
    levelsContainer.append(row);
  });
}

function renderOrderflow(instrument) {
  const contract = instrument.contract;
  document.getElementById('chart-instrument-title').textContent = contract
    ? `${contract.description} · expiry ${contract.expiryLabel || contract.expiryDate || 'unavailable'}`
    : instrument.symbol || `${selectedSymbol} FUTURES`;
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
  const fyersSource = Boolean(instrument.fyersOrderflow?.candleFresh?.[selectedTimeframe])
    && Boolean(instrument.fyersOrderflow?.candles?.[selectedTimeframe]?.length);
  const connection = marketData?.status;
  const feedMessage = !contract
    ? 'Loading the current futures contract from FYERS.'
    : connection === 'connected'
      ? `FYERS connected to ${contract.symbol}. Waiting for market ticks; live candles update during exchange hours.`
      : connection === 'connecting'
        ? 'Connecting to FYERS. The active expiry contract will appear as soon as the feed is ready.'
        : `Connect FYERS to stream ${contract.symbol}.`;
  const emptyMessage = !contract
    ? 'Loading active futures contract'
    : connection === 'connected'
      ? 'Connected · waiting for market ticks'
      : 'Connect FYERS for live active-contract data';
  document.getElementById('chart-data-status').textContent = bars.length
    ? `${fyersSource ? 'Fresh FYERS footprint' : connection === 'connected' ? 'Live tick-derived orderflow' : 'Last available orderflow'} · ${bars.length} ${selectedTimeframe}-minute bars.`
    : feedMessage;
  document.getElementById('chart-status').textContent = bars.length
    ? `${bars.length} ${selectedTimeframe}m bars${fyersSource ? ' · FYERS footprint' : connection === 'connected' ? ' · LIVE' : ' · SAVED'}`
    : connection === 'connected' ? 'WAITING FOR MARKET TICKS' : 'NO LIVE MARKET DATA';
  document.getElementById('delta-chart-source').textContent = fyersSource ? 'FYERS footprint' : 'Tick-rule estimate';
  document.getElementById('cvd-chart-source').textContent = fyersSource ? 'FYERS session CVD' : 'Since feed connection';
  document.getElementById('chart-disclaimer').textContent = fyersSource
    ? 'Numeric FYERS price-level Ask/Bid footprint captured from your chart session.'
    : 'Tick-based buy/sell estimate; this is not numeric bid/ask footprint depth.';
  drawPriceChart(bars.slice(-80), emptyMessage);
  drawDeltaChart(bars.slice(-80), emptyMessage);
  drawCvdChart(bars.slice(-80), emptyMessage);
  renderFyersCapture(instrument);
}

function renderTradeSummary(data) {
  const summary = document.getElementById('market-summary-content');
  const reversalSummary = document.getElementById('reversal-summary-content');
  if (!summary || !reversalSummary) return;
  const analysis = data?.analysis;
  if (!analysis) return;
  const move = Number.isFinite(analysis.sessionMove)
    ? `Open se ${formatSigned(analysis.sessionMove, ' pts')}`
    : 'Open se move unavailable';
  const area = analysis.deltaArea;
  const fresh = Boolean(data.marketDay && analysis.marketDataFresh && analysis.footprintDataFresh);
  const areaText = area
    ? `${area.direction === 'UP' ? 'Buy' : 'Sell'} delta ${formatNumber(area.low)}–${formatNumber(area.high)} · net Δ ${formatSigned(area.netDelta)}`
    : 'Strong same-direction delta area nahi mila';
  const continuation = !fresh
    ? 'Fresh live data ka wait'
    : !area
      ? 'No continuation entry'
      : area.accepted
        ? `Accepted · pullback area ${formatNumber(area.low)}–${formatNumber(area.high)}`
        : 'Acceptance ka wait · abhi entry nahi';
  summary.textContent = `${move} · ${areaText} · ${continuation}`;

  const reversal = analysis.reversalSetup;
  const reversalDirection = reversal?.direction === 'DOWN' ? 'SHORT' : 'LONG';
  reversalSummary.textContent = !fresh
    ? 'Fresh live data ka wait; reversal signal nahi.'
    : !reversal
      ? 'Clear trend aur enough completed footprint candles ka wait.'
      : reversal.status === 'SIGNAL'
        ? `${reversalDirection} reversal SIGNAL · delta divergence · absorption ${formatNumber(reversal.absorptionRange.low)}–${formatNumber(reversal.absorptionRange.high)} · volume exhaustion${reversal.stackedImbalance ? ' · stacked imbalance confirm' : ''} · trigger ${formatNumber(reversal.entryTrigger)}`
        : reversal.status === 'WATCH'
          ? `${reversalDirection} reversal WATCH · ${reversal.conditionsMet}/3 core conditions met${reversal.stackedImbalance ? ' · stacked imbalance confirm' : ''}`
          : `${reversalDirection} reversal · delta divergence, absorption aur exhaustion ka wait`;
}

function renderOpeningConviction(instrument) {
  const conviction = instrument.openingConviction || {};
  const labels = {
    UP: 'OPENED ABOVE VALUE',
    DOWN: 'OPENED BELOW VALUE',
    INSIDE: 'OPENED INSIDE VALUE',
    WAITING_OPEN: 'WAITING FOR OPEN',
    WAITING_PRIOR_VALUE: 'NO PRIOR VALUE',
    WAITING_FOR_MARKET_SESSION: 'WAITING FOR NEXT MARKET SESSION'
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

  const element = document.getElementById('opening-status');
  element.textContent = status;
  element.dataset.bias = conviction.direction || 'waiting';
  document.getElementById('opening-comparison').textContent = comparison;
  document.getElementById('opening-reference').textContent = reference;
}

function updateInstrument() {
  if (!marketData) return;
  const instrument = marketData.instruments?.[selectedSymbol];
  if (!instrument) return;

  document.getElementById('symbol-label').textContent = instrument.symbol || `${selectedSymbol} FUTURES`;
  const contract = instrument.contract;
  document.getElementById('active-contract').textContent = contract
    ? `${selectedSymbol} CONTRACT · ${contract.symbol} · ${contract.description} · EXPIRY ${contract.expiryLabel || contract.expiryDate || 'DATE UNAVAILABLE'}${contract.expired ? ' · EXPIRED' : ''}`
    : `${selectedSymbol} CONTRACT · ${instrument.symbol || 'waiting for FYERS symbol master'}`;
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
  delta.textContent = instrument.updatedAt || instrument.deltaSource === 'FYERS_CHART'
    ? formatSigned(instrument.delta)
    : '--';
  setTone(delta, instrument.delta);
  document.getElementById('delta-note').textContent = instrument.deltaSource === 'FYERS_CHART'
    ? 'FYERS footprint · 5-minute candle'
    : 'tick-rule estimate';
  const cvd = document.getElementById('cvd');
  cvd.textContent = instrument.updatedAt || instrument.cvdSource === 'FYERS_CHART'
    ? formatSigned(instrument.cvd)
    : '--';
  setTone(cvd, instrument.cvd);
  document.getElementById('cvd-note').textContent = instrument.cvdSource === 'FYERS_CHART'
    ? 'FYERS session volume profile'
    : 'since feed connection';
  document.getElementById('flow-source').textContent = instrument.flowSource === 'FYERS_CHART'
    ? 'FYERS footprint'
    : 'tick-rule estimate';

  updateProfile(instrument);
  renderOverviewCapture(instrument);
  renderOpeningConviction(instrument);
  renderFlow(instrument.flow);
}

function setView(view) {
  activeView = view;
  document.querySelectorAll('[data-overview]').forEach((section) => {
    section.hidden = view !== 'overview';
  });
  document.getElementById('market-read-view').hidden = view !== 'read';
}

function renderMarketRead(data) {
  const analysis = data.analysis;
  const current = data.sessions.at(-1);
  const previous = data.sessions.find((session) => session.date === analysis.previousDate);
  renderTradeSummary(data);
  document.getElementById('market-read-title').textContent = `${data.instrument} · Detailed market read`;
  const status = document.getElementById('market-read-status');
  const dataTime = current?.updatedAt ? formatTime(Date.parse(current.updatedAt)) : 'unknown';
  const marketStatus = data.marketDay || analysis.readiness === 'MARKET_CLOSED' ? '' : 'MARKET CLOSED (WEEKEND) · ';
  const freshness = [
    analysis.marketDataFresh ? `live data as of ${dataTime} IST` : 'live market data is stale',
    analysis.footprintDataFresh ? '5-minute footprint fresh' : '5-minute footprint stale'
  ].join(' · ');
  status.textContent = `${marketStatus}${analysis.readiness.replaceAll('_', ' ')} · ${freshness} · ${data.sessions.length} session(s) saved · FYERS footprint`;
  status.dataset.state = analysis.readiness === 'CONTINUATION_AREA_ACCEPTED' ? 'ready' : 'waiting';
  const valueContext = analysis.priceVsPreviousValue === 'ABOVE_VALUE'
    ? 'Price is above the previous value area'
    : analysis.priceVsPreviousValue === 'BELOW_VALUE'
      ? 'Price is below the previous value area'
      : analysis.priceVsPreviousValue === 'INSIDE_VALUE'
        ? 'Price is inside the previous value area'
        : 'Previous value area is unavailable';
  const deltaContext = analysis.deltaAlignment === 'ALIGNED'
    ? 'full-session delta supports the 5-minute price structure'
    : analysis.deltaAlignment === 'DIVERGING'
      ? 'full-session delta conflicts with the 5-minute price structure'
      : 'full-session delta does not yet confirm a clear structure';
  document.getElementById('read-session-story').textContent = current
    ? `${valueContext}; 5-minute price structure is ${analysis.trendDirection.toLowerCase()}, and ${deltaContext}. Opening context is ${analysis.openingDirection.toLowerCase()} and contributes only a small supporting weight—not a standalone direction call. ${data.marketDay ? analysis.marketDataFresh ? 'Market data is fresh.' : 'Market data is stale, so no new entry is evaluated.' : `Market is closed; showing the saved ${current.date} session for context only.`}`
    : 'Waiting for current-session candles and previous-session levels.';
  document.getElementById('read-market-behavior').textContent = analysis.marketBehavior
    || 'Waiting for completed real FYERS price-level bid/ask footprint.';

  const move = document.getElementById('read-session-move');
  move.textContent = Number.isFinite(analysis.sessionMove) ? formatSigned(analysis.sessionMove, ' pts') : '--';
  setTone(move, analysis.sessionMove);
  document.getElementById('read-session-move-label').textContent = data.marketDay ? 'SESSION MOVE' : 'LAST SESSION MOVE';
  document.getElementById('read-session-range').textContent = current
    ? `${current.date} · Open ${formatNumber(analysis.sessionOpen)} → close/last ${formatNumber(analysis.currentPrice)} · H ${formatNumber(current.high)} / L ${formatNumber(current.low)}`
    : 'Waiting for session data';
  document.getElementById('read-structure').textContent = analysis.trendDirection === 'UP'
    ? 'UPWARD'
    : analysis.trendDirection === 'DOWN' ? 'DOWNWARD' : 'MIXED';
  document.getElementById('read-structure-detail').textContent = `${analysis.completedCandleCount} completed 5-minute candles analyzed for this session.`;
  const delta = document.getElementById('read-delta');
  delta.textContent = formatSigned(analysis.sessionDelta);
  setTone(delta, analysis.sessionDelta);
  document.getElementById('read-cvd').textContent = `Session CVD: ${formatSigned(analysis.cumulativeDelta)}`;
  const imbalance = analysis.lastImbalance;
  const imbalanceLabel = imbalance?.direction === 'UP'
    ? `BUY STACK ×${imbalance.buyStack}`
    : imbalance?.direction === 'DOWN' ? `SELL STACK ×${imbalance.sellStack}` : 'NO STACKED IMBALANCE';
  document.getElementById('read-imbalance').textContent = imbalanceLabel;
  document.getElementById('read-imbalance-detail').textContent = imbalance
    ? `${imbalance.buyImbalanceCount} buy / ${imbalance.sellImbalanceCount} sell diagonal imbalances in the latest completed candle.`
    : 'No completed footprint candle yet.';

  const buyingArea = analysis.buyingArea;
  document.getElementById('read-buying-area').textContent = buyingArea ? formatNumber(buyingArea.price) : '--';
  document.getElementById('read-buying-area-detail').textContent = buyingArea
    ? `Buy ${formatNumber(buyingArea.buyerVolume)} · Sell ${formatNumber(buyingArea.sellerVolume)} at price`
    : 'No current-session footprint volume';
  const sellingArea = analysis.sellingArea;
  document.getElementById('read-selling-area').textContent = sellingArea ? formatNumber(sellingArea.price) : '--';
  document.getElementById('read-selling-area-detail').textContent = sellingArea
    ? `Sell ${formatNumber(sellingArea.sellerVolume)} · Buy ${formatNumber(sellingArea.buyerVolume)} at price`
    : 'No current-session footprint volume';

  document.getElementById('read-previous-date').textContent = previous?.date || 'No prior session loaded';
  document.getElementById('read-opening-context').textContent = `Open context: ${analysis.openingDirection || 'UNKNOWN'} · supporting clue only`;
  const priorLevels = document.getElementById('read-prior-levels');
  priorLevels.replaceChildren();
  const levelValues = previous ? [
    ['SESSION VAH', current?.vah],
    ['SESSION POC', current?.poc],
    ['SESSION VAL', current?.val],
    ['VAH', previous.vah],
    ['POC', previous.poc],
    ['VAL', previous.val],
    ['PRIOR HIGH', previous.high],
    ['PRIOR LOW', previous.low],
    ['PRIOR HVNS', analysis.previousLevels?.hvns?.length ? analysis.previousLevels.hvns.slice(0, 5).map(formatNumber).join(' · ') : null],
    ['PRIOR LVNS', analysis.previousLevels?.lvns?.length ? analysis.previousLevels.lvns.slice(0, 5).map(formatNumber).join(' · ') : null]
  ] : [['PRIOR SESSION', null]];
  levelValues.forEach(([label, value]) => {
    const item = document.createElement('div');
    const heading = document.createElement('span');
    heading.textContent = label;
    const content = document.createElement('strong');
    content.textContent = Array.isArray(value) ? value.join(' · ') : Number.isFinite(value) ? formatNumber(value) : value || '--';
    item.append(heading, content);
    priorLevels.append(item);
  });

  const plan = analysis.tradePlan;
  document.getElementById('read-plan-title').textContent = plan
    ? `${plan.direction === 'UP' ? 'LONG' : 'SHORT'} · ${plan.model}`
    : 'No qualified entry';
  document.getElementById('read-plan-reason').textContent = analysis.reason;
  document.getElementById('read-evidence-score').textContent = plan ? `EVIDENCE ${plan.evidenceScore}/100` : 'NO TRADE';
  const planDetails = document.getElementById('read-plan-details');
  planDetails.replaceChildren();
  if (plan) {
    [
      ['ENTRY TRIGGER', formatNumber(plan.entry)],
      ['STOP LOSS', formatNumber(plan.stop)],
      ['TAKE PROFIT', formatNumber(plan.target)],
      ['RISK : REWARD', `1 : ${numberFormat.format(plan.riskReward)}`],
      ['SETUP STATUS', plan.status.replaceAll('_', ' ')]
    ].forEach(([label, value]) => {
      const item = document.createElement('div');
      const heading = document.createElement('span');
      heading.textContent = label;
      const content = document.createElement('strong');
      content.textContent = value;
      item.append(heading, content);
      planDetails.append(item);
    });
    document.getElementById('read-plan-reason').textContent = `${analysis.reason} ${plan.maximumHold}`;
    const factors = plan.evidence.map((factor) => `${factor.name} ${factor.points}/${factor.maxPoints}`);
    document.getElementById('read-plan-reason').textContent += ` Evidence breakdown: ${factors.join('; ')}.`;
  }

  const confluenceList = document.getElementById('read-confluences');
  confluenceList.replaceChildren();
  (analysis.confluences || []).forEach((factor) => {
    const item = document.createElement('div');
    item.className = `confluence-item${factor.present ? ' present' : ' absent'}`;
    const heading = document.createElement('strong');
    heading.textContent = factor.name;
    const detail = document.createElement('span');
    detail.textContent = factor.detail;
    item.append(heading, detail);
    confluenceList.append(item);
  });

  const demoTrades = document.getElementById('read-demo-trades');
  demoTrades.replaceChildren();
  const openTrades = data.demoTrades || [];
  if (!openTrades.length) {
    const empty = document.createElement('p');
    empty.className = 'demo-trade-empty';
    empty.textContent = 'No saved setup is waiting or open. Qualified setups are saved automatically; a demo trade opens only after the live price touches its entry trigger.';
    demoTrades.append(empty);
  } else {
    openTrades.forEach((trade) => {
      const card = document.createElement('article');
      card.className = `demo-trade-card ${trade.status === 'ACTIVE' ? 'active' : 'waiting'}`;
      const heading = document.createElement('div');
      heading.className = 'demo-trade-card-heading';
      const title = document.createElement('strong');
      title.textContent = `${trade.direction === 'UP' ? 'LONG' : 'SHORT'} · ${trade.model}`;
      const state = document.createElement('span');
      state.textContent = trade.status === 'ACTIVE' ? 'OPEN · DEMO' : 'WAITING FOR ENTRY';
      heading.append(title, state);
      const levels = document.createElement('p');
      levels.textContent = `Entry ${formatNumber(trade.entry)} · Stop ${formatNumber(trade.stop)} · Target ${formatNumber(trade.target)} · Live ${formatNumber(trade.currentPrice)}`;
      card.append(heading, levels);
      if (trade.status === 'ACTIVE' && Number.isFinite(trade.unrealizedR)) {
        const result = document.createElement('small');
        result.textContent = `Unrealized ${formatSigned(trade.unrealizedR, 'R')} · simulated from live price`;
        card.append(result);
      }
      demoTrades.append(card);
    });
  }

}

async function openMarketRead({ refresh = false } = {}) {
  if (!refresh) setView('read');
  const status = document.getElementById('market-read-status');
  if (!refresh) {
    status.textContent = 'Loading saved FYERS footprint and session history…';
    status.dataset.state = 'loading';
  }
  try {
    const response = await fetch(`/api/orderflow-history/${encodeURIComponent(selectedSymbol)}`);
    if (!response.ok) throw new Error(`Market history request failed (${response.status})`);
    renderMarketRead(await response.json());
  } catch (error) {
    status.textContent = `Could not load market history: ${error.message}`;
    status.dataset.state = 'error';
  }
}

function updateConnection(state) {
  const status = document.getElementById('feed-status-wrap');
  const label = document.getElementById('feed-status');
  const message = document.getElementById('feed-message');
  const connectButton = document.getElementById('connect-button');
  status.dataset.state = state.status;
  label.textContent = state.status === 'connected'
    ? 'LIVE TICKS'
    : state.status === 'connecting'
      ? state.message.toLowerCase().includes('reconnect') ? 'RECONNECTING' : 'CONNECTING'
      : 'DISCONNECTED';
  message.textContent = state.message;
  connectButton.hidden = state.status === 'connected' || state.status === 'connecting';
}

function selectSymbol(symbol) {
  selectedSymbol = symbol;
  document.querySelectorAll('[data-symbol]').forEach((button) => {
    button.classList.toggle('active', button.dataset.symbol === symbol);
  });
  updateInstrument();
  if (activeView === 'read') openMarketRead();
}

instrumentButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectSymbol(button.dataset.symbol);
  });
});

document.getElementById('market-read-toggle').addEventListener('click', openMarketRead);
document.getElementById('market-read-refresh').addEventListener('click', openMarketRead);
document.getElementById('market-read-back').addEventListener('click', () => setView('overview'));

const stream = new EventSource('/api/market-stream');
stream.addEventListener('message', (event) => {
  marketData = JSON.parse(event.data);
  updateConnection(marketData);
  updateInstrument();
});
stream.addEventListener('error', () => {
  if (stream.readyState === EventSource.CLOSED) {
    document.getElementById('feed-status-wrap').dataset.state = 'disconnected';
    document.getElementById('feed-status').textContent = 'SERVER OFFLINE';
    document.getElementById('feed-message').textContent = 'Dashboard stream closed.';
    return;
  }
  document.getElementById('feed-status-wrap').dataset.state = 'connecting';
  document.getElementById('feed-status').textContent = 'RECONNECTING';
  document.getElementById('feed-message').textContent = 'Dashboard updates paused; the browser is reconnecting. FYERS feed status will update when the stream returns.';
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
setInterval(() => {
  if (activeView === 'read') void openMarketRead({ refresh: true });
}, 2000);