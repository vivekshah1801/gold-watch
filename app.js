/* Gold Watch — app.js v2.0.0 */
'use strict';

/* ═══════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════ */
const DATA_URL = './data.json';
const STORAGE_KEY = 'goldwatch_v1';
const MAX_LOG = 20;
const INTERVALS = [30, 60, 120, 180, 240, 360, 720, 1440]; /* minutes */

/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
let state = {
  prices: [],          /* [{date, price}] */
  lastPrice: null,
  prevPrice: null,
  lastFetch: null,
  log: [],
  thresholds: {
    priceAbove: '',
    priceBelow: '',
    pctRise: '',
    pctDrop: ''
  },
  interval: 60,        /* minutes */
  notifyEnabled: false,
  activeRange: '3M',
  pollTimer: null
};

let chart = null;

/* ═══════════════════════════════════════════════
   STORAGE
═══════════════════════════════════════════════ */
function saveState() {
  try {
    const toSave = {
      prices: state.prices.slice(-200), /* keep last 200 data points */
      lastPrice: state.lastPrice,
      prevPrice: state.prevPrice,
      lastFetch: state.lastFetch,
      log: state.log.slice(0, MAX_LOG),
      thresholds: state.thresholds,
      interval: state.interval,
      notifyEnabled: state.notifyEnabled
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (e) {
    logEntry('warn', 'Could not save state: ' + e.message);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(state, saved);
  } catch (e) {
    console.warn('Gold Watch: could not load state', e);
  }
}

/* ═══════════════════════════════════════════════
   LOGGING
═══════════════════════════════════════════════ */
function logEntry(type, msg) {
  const entry = { type, msg, ts: Date.now() };
  state.log.unshift(entry);
  if (state.log.length > MAX_LOG) state.log.pop();
  renderLog();
  saveState();
}

/* ═══════════════════════════════════════════════
   API FETCH (same-origin data.json, built by CI)
═══════════════════════════════════════════════ */
async function fetchGoldData() {
  setFetchStatus('loading');
  try {
    const res = await fetch(DATA_URL + '?t=' + Date.now(), { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error === 'fetch_failed') throw new Error('API fetch failed on server');
    parseAndStore(data);
    logEntry('ok', 'Data refreshed');
    setFetchStatus('ok');
    return true;
  } catch (err) {
    logEntry('error', 'Fetch error: ' + err.message);
    setFetchStatus('error');
    return false;
  }
}

function parseAndStore(data) {
  /* Actual API shape: { data: { points: [{ts, val}] }, success: true }
     Also handle legacy shapes: { data: { candles: [[date,...]] } }
     and { data: [{date, close}] } */
  let points = [];

  if (data && data.data) {
    const d = data.data;

    /* Primary shape: {points: [{ts, val}]} */
    if (Array.isArray(d.points)) {
      points = d.points.map(c => ({
        date: c.ts || c.date || c.timestamp,
        price: parseFloat(c.val || c.close || c.price || c.nav)
      }));
    } else if (Array.isArray(d.candles)) {
      /* Legacy OHLCV candles: [date, open, high, low, close, vol] → close */
      points = d.candles.map(c => ({
        date: c[0],
        price: parseFloat(c.length >= 5 ? c[4] : c[1])
      }));
    } else if (Array.isArray(d)) {
      points = d.map(c => {
        if (Array.isArray(c)) return { date: c[0], price: parseFloat(c.length >= 5 ? c[4] : c[1]) };
        return { date: c.ts || c.date || c.timestamp, price: parseFloat(c.val || c.close || c.price || c.nav) };
      });
    }
  }

  if (points.length === 0) {
    logEntry('warn', 'Unexpected API shape — check console');
    console.warn('Gold Watch raw data:', data);
    return;
  }

  /* Sort ascending */
  points.sort((a, b) => new Date(a.date) - new Date(b.date));

  state.prevPrice = state.lastPrice;
  state.prices = points;
  state.lastPrice = points[points.length - 1].price;
  state.lastFetch = Date.now();

  saveState();
  renderAll();
  checkThresholds();
}

/* ═══════════════════════════════════════════════
   THRESHOLD CHECK
═══════════════════════════════════════════════ */
function checkThresholds() {
  if (!state.lastPrice) return;
  const t = state.thresholds;
  const price = state.lastPrice;
  const prev = state.prevPrice;

  const triggered = [];

  if (t.priceAbove && price >= parseFloat(t.priceAbove)) {
    triggered.push({ msg: `Price ₹${fmt(price)} crossed above ₹${fmt(t.priceAbove)}`, type: 'warn' });
  }
  if (t.priceBelow && price <= parseFloat(t.priceBelow)) {
    triggered.push({ msg: `Price ₹${fmt(price)} dropped below ₹${fmt(t.priceBelow)}`, type: 'warn' });
  }
  if (t.pctRise && prev) {
    const pct = ((price - prev) / prev) * 100;
    if (pct >= parseFloat(t.pctRise)) {
      triggered.push({ msg: `Rose ${pct.toFixed(2)}% → ₹${fmt(price)}`, type: 'warn' });
    }
  }
  if (t.pctDrop && prev) {
    const pct = ((prev - price) / prev) * 100;
    if (pct >= parseFloat(t.pctDrop)) {
      triggered.push({ msg: `Fell ${pct.toFixed(2)}% → ₹${fmt(price)}`, type: 'warn' });
    }
  }

  triggered.forEach(t => {
    logEntry(t.type, '🔔 Alert: ' + t.msg);
  });

  /* Tell SW to fire push notifications */
  if (triggered.length > 0 && state.notifyEnabled) {
    navigator.serviceWorker.ready.then(reg => {
      reg.active && reg.active.postMessage({
        type: 'CHECK_ALERT',
        price,
        prevPrice: prev,
        thresholds: {
          priceAbove: t.priceAbove ? parseFloat(t.priceAbove) : null,
          priceBelow: t.priceBelow ? parseFloat(t.priceBelow) : null,
          pctRise: t.pctRise ? parseFloat(t.pctRise) : null,
          pctDrop: t.pctDrop ? parseFloat(t.pctDrop) : null
        }
      });
    }).catch(() => {});
  }
}

/* ═══════════════════════════════════════════════
   POLLING SCHEDULER
═══════════════════════════════════════════════ */
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const ms = state.interval * 60 * 1000;
  state.pollTimer = setInterval(() => {
    logEntry('ok', `Scheduled check (every ${state.interval}min)`);
    fetchGoldData();
  }, ms);
}

/* ═══════════════════════════════════════════════
   CHART
═══════════════════════════════════════════════ */
function getFilteredPrices() {
  if (!state.prices.length) return [];
  const now = Date.now();
  const cutoffs = { '1M': 31, '3M': 92, '6M': 183 };
  const days = cutoffs[state.activeRange] || 183;
  const cutoff = now - days * 86400000;
  const filtered = state.prices.filter(p => new Date(p.date).getTime() >= cutoff);
  return filtered.length >= 2 ? filtered : state.prices.slice(-30);
}

function buildChart() {
  const ctx = document.getElementById('priceChart');
  if (!ctx) return;
  const pts = getFilteredPrices();
  const labels = pts.map(p => p.date);
  const data = pts.map(p => p.price);

  const lineColor = '#B8741A';
  const fillColor = 'rgba(184,116,26,0.07)';
  const gridColor = 'rgba(0,0,0,0.05)';
  const tickColor = 'rgba(0,0,0,0.35)';

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: lineColor,
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: lineColor,
        fill: true,
        backgroundColor: fillColor,
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      elements: { point: { radius: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#ffffff',
          borderColor: 'rgba(0,0,0,0.1)',
          borderWidth: 1,
          titleColor: '#7a7068',
          bodyColor: '#1c1814',
          bodyFont: { size: 13, weight: '500' },
          padding: 10,
          callbacks: {
            title: items => fmtDate(items[0].label),
            label: ctx => ' ₹' + fmt(ctx.parsed.y)
          }
        }
      },
      scales: {
        x: { display: false },
        y: {
          display: true,
          position: 'right',
          grid: { color: gridColor, drawTicks: false },
          border: { display: false },
          ticks: {
            font: { size: 10 },
            color: tickColor,
            maxTicksLimit: 5,
            callback: v => '₹' + (v / 1000).toFixed(1) + 'k',
            padding: 6
          }
        }
      }
    }
  });
  updateAxisLabels();
}

function updateChart() {
  if (!chart) { buildChart(); return; }
  const pts = getFilteredPrices();
  chart.data.labels = pts.map(p => p.date);
  chart.data.datasets[0].data = pts.map(p => p.price);
  chart.update('active');
  updateAxisLabels();
}

function updateAxisLabels() {
  const container = el('chartAxisLabels');
  if (!container) return;
  const pts = getFilteredPrices();
  if (pts.length < 2) return;
  const spans = container.querySelectorAll('span');
  const count = spans.length;
  /* Pick evenly-spaced indices */
  spans.forEach((span, i) => {
    const idx = Math.round(i * (pts.length - 1) / (count - 1));
    span.textContent = fmtDateShort(pts[idx].date);
  });
}

/* ═══════════════════════════════════════════════
   RENDER
═══════════════════════════════════════════════ */
function renderAll() {
  renderMetrics();
  updateChart();
  renderLog();
  renderLastUpdated();
}

function renderMetrics() {
  const pts = state.prices;
  if (!pts.length) return;

  const latest = pts[pts.length - 1].price;
  const weekAgo = pts.length >= 7 ? pts[pts.length - 7].price : pts[0].price;
  const dayAgo = pts.length >= 2 ? pts[pts.length - 2].price : latest;

  const todayPct = ((latest - dayAgo) / dayAgo * 100);
  const weekDiff = latest - weekAgo;

  el('currentPrice').textContent = '₹' + fmt(latest);
  const todayEl = el('todayChange');
  todayEl.textContent = (todayPct >= 0 ? '+' : '') + todayPct.toFixed(2) + '% today';
  todayEl.className = 'metric-change ' + (todayPct >= 0 ? 'up' : 'down');

  el('weekChange').textContent = (weekDiff >= 0 ? '+₹' : '−₹') + fmt(Math.abs(weekDiff));
  el('weekFrom').textContent = 'from ₹' + fmt(weekAgo);
}

function renderLog() {
  const container = el('logList');
  if (!container) return;
  if (!state.log.length) {
    container.innerHTML = '<div class="log-empty">No activity yet</div>';
    return;
  }
  container.innerHTML = state.log.slice(0, 8).map(entry => {
    const icon = entry.type === 'error' ? 'ti-alert-circle' :
                 entry.type === 'warn'  ? 'ti-bell-ringing' : 'ti-check';
    const cls  = entry.type === 'error' ? 'error' :
                 entry.type === 'warn'  ? 'warn' : 'ok';
    return `<div class="log-item">
      <div class="log-icon ${cls}"><i class="ti ${icon}" aria-hidden="true"></i></div>
      <div class="log-text">
        <div class="log-msg">${escHtml(entry.msg)}</div>
        <div class="log-time">${fmtTs(entry.ts)}</div>
      </div>
    </div>`;
  }).join('');
}

function renderLastUpdated() {
  const el2 = el('lastUpdated');
  if (!el2) return;
  el2.textContent = state.lastFetch
    ? 'Updated ' + fmtTs(state.lastFetch)
    : 'Not yet fetched';
}

function setFetchStatus(s) {
  const pill = el('statusPill');
  const dot  = el('statusDot');
  const spin = el('spinIcon');
  const txt  = el('statusText');
  if (!pill) return;
  if (s === 'loading') {
    pill.className = 'status-pill loading';
    if (txt)  txt.textContent = 'Fetching…';
    if (spin) spin.style.display = 'inline';
    if (dot)  dot.style.display = 'none';
  } else if (s === 'ok') {
    pill.className = 'status-pill ok';
    if (txt)  txt.textContent = 'Watching';
    if (spin) spin.style.display = 'none';
    if (dot)  { dot.style.display = 'inline-block'; dot.className = 'status-dot ok'; }
  } else {
    pill.className = 'status-pill error';
    if (txt)  txt.textContent = 'Error';
    if (spin) spin.style.display = 'none';
    if (dot)  { dot.style.display = 'inline-block'; dot.className = 'status-dot error'; }
  }
}

/* ═══════════════════════════════════════════════
   NOTIFICATIONS
═══════════════════════════════════════════════ */
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    logEntry('warn', 'Notifications not supported in this browser');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

/* ═══════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════ */
function wireEvents() {
  /* Refresh button */
  el('btnRefresh').addEventListener('click', () => {
    logEntry('ok', 'Manual refresh');
    fetchGoldData();
  });

  /* Save thresholds */
  el('btnSave').addEventListener('click', () => {
    state.thresholds.priceAbove = el('inputPriceAbove').value.trim();
    state.thresholds.priceBelow = el('inputPriceBelow').value.trim();
    state.thresholds.pctRise    = el('inputPctRise').value.trim();
    state.thresholds.pctDrop    = el('inputPctDrop').value.trim();
    state.interval = parseInt(el('selectInterval').value, 10) || 60;
    saveState();
    startPolling();
    logEntry('ok', 'Thresholds saved · Polling every ' + state.interval + 'min');
    showSavedFeedback();
  });

  /* Notification toggle */
  el('toggleNotify').addEventListener('click', async () => {
    if (!state.notifyEnabled) {
      const granted = await requestNotificationPermission();
      if (granted) {
        state.notifyEnabled = true;
        try {
          const reg = await navigator.serviceWorker.ready;
          reg.active.postMessage({ type: 'NOTIFY_TEST' });
          logEntry('ok', 'Notifications enabled — test sent');
        } catch (e) {
          logEntry('warn', 'SW not ready: ' + e.message);
        }
      } else {
        logEntry('warn', 'Notification permission denied');
        return;
      }
    } else {
      state.notifyEnabled = false;
      logEntry('ok', 'Notifications disabled');
    }
    saveState();
    updateToggleUI();
  });

  /* Range tabs */
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeRange = btn.dataset.range;
      updateChart();
    });
  });
}

function updateToggleUI() {
  const toggle = el('toggleNotify');
  if (!toggle) return;
  toggle.classList.toggle('on', state.notifyEnabled);
  el('notifyLabel').textContent = state.notifyEnabled ? 'Notifications on' : 'Notifications off';
}

function showSavedFeedback() {
  const btn = el('btnSave');
  const orig = btn.textContent;
  btn.textContent = '✓ Saved';
  btn.style.background = '#2a7a2a';
  setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 1500);
}

function populateUI() {
  if (el('inputPriceAbove')) el('inputPriceAbove').value = state.thresholds.priceAbove || '';
  if (el('inputPriceBelow')) el('inputPriceBelow').value = state.thresholds.priceBelow || '';
  if (el('inputPctRise'))    el('inputPctRise').value    = state.thresholds.pctRise    || '';
  if (el('inputPctDrop'))    el('inputPctDrop').value    = state.thresholds.pctDrop    || '';
  const sel = el('selectInterval');
  if (sel) sel.value = String(state.interval || 60);
  updateToggleUI();
}

/* ═══════════════════════════════════════════════
   SERVICE WORKER
═══════════════════════════════════════════════ */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    console.log('Gold Watch SW registered:', reg.scope);
  } catch (e) {
    console.warn('SW registration failed:', e);
  }
}

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
function el(id) { return document.getElementById(id); }

function fmt(n) {
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function fmtDate(str) {
  try {
    return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch { return str; }
}

function fmtDateShort(str) {
  try {
    return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch { return str; }
}

function fmtTs(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return isToday ? 'Today, ' + time : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + time;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ═══════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  loadState();
  populateUI();
  wireEvents();
  await registerSW();

  /* Render stale data immediately if we have it */
  if (state.prices.length) {
    renderAll();
    buildChart();
  }

  /* Fetch fresh data */
  await fetchGoldData();

  /* Build chart after first fetch if not yet built */
  if (!chart) buildChart();

  /* Start recurring poll */
  startPolling();
});
