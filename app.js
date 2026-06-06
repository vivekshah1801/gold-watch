/* Gold Watch — app.js v3.0.0 */
'use strict';

/* ═══════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════ */
const DATA_URL    = './data.json';
const STORAGE_KEY = 'goldwatch_v3';
const CFG_CACHE   = 'gold-watch-config';
const CFG_KEY     = '/gw-config';

/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
let state = {
  prices:       [],
  lastPrice:    null,
  prevPrice:    null,
  lastFetch:    null,
  thresholds:   { priceAbove: '', priceBelow: '', pctRise: '', pctDrop: '' },
  interval:     60,
  notifyEnabled: false,
  activeRange:  '3M',
  pollTimer:    null
};

let chart = null;

/* ═══════════════════════════════════════════════
   STORAGE (localStorage for app state)
═══════════════════════════════════════════════ */
function saveState() {
  try {
    const toSave = {
      prices:        state.prices.slice(-200),
      lastPrice:     state.lastPrice,
      prevPrice:     state.prevPrice,
      lastFetch:     state.lastFetch,
      thresholds:    state.thresholds,
      interval:      state.interval,
      notifyEnabled: state.notifyEnabled
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.warn('[App] saveState failed:', e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    Object.assign(state, JSON.parse(raw));
    console.log('[App] State loaded from localStorage');
  } catch (e) {
    console.warn('[App] loadState failed:', e);
  }
}

/* ═══════════════════════════════════════════════
   CONFIG CACHE (shared with SW via Cache API)
═══════════════════════════════════════════════ */
async function saveConfigToCache(patch) {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(CFG_CACHE);
    let current = {};
    try {
      const res = await cache.match(CFG_KEY);
      if (res) current = await res.json();
    } catch {}
    const updated = Object.assign({}, current, patch);
    await cache.put(CFG_KEY, new Response(JSON.stringify(updated), {
      headers: { 'Content-Type': 'application/json' }
    }));
    console.log('[App] Config cache updated:', JSON.stringify(patch));
  } catch (e) {
    console.warn('[App] saveConfigToCache failed:', e);
  }
}

/* ═══════════════════════════════════════════════
   API FETCH (same-origin data.json, built by CI)
═══════════════════════════════════════════════ */
async function fetchGoldData() {
  setFetchStatus('loading');
  console.log('[App] Fetching data.json…');
  try {
    const res = await fetch(DATA_URL + '?t=' + Date.now(), { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error === 'fetch_failed') throw new Error('CI fetch failed');
    console.log('[App] data.json OK, parsing…');
    parseAndStore(data);
    setFetchStatus('ok');
    return true;
  } catch (err) {
    console.error('[App] fetchGoldData error:', err.message);
    setFetchStatus('error');
    return false;
  }
}

function parseAndStore(data) {
  let points = [];

  if (data && data.data) {
    const d = data.data;
    if (Array.isArray(d.points)) {
      points = d.points.map(c => ({
        date:  c.ts || c.date || c.timestamp,
        price: parseFloat(c.val || c.close || c.price || c.nav)
      }));
    } else if (Array.isArray(d.candles)) {
      points = d.candles.map(c => ({
        date:  c[0],
        price: parseFloat(c.length >= 5 ? c[4] : c[1])
      }));
    } else if (Array.isArray(d)) {
      points = d.map(c => Array.isArray(c)
        ? { date: c[0], price: parseFloat(c.length >= 5 ? c[4] : c[1]) }
        : { date: c.ts || c.date || c.timestamp, price: parseFloat(c.val || c.close || c.price || c.nav) }
      );
    }
  }

  if (!points.length) {
    console.warn('[App] Unexpected data shape:', data);
    return;
  }

  points.sort((a, b) => new Date(a.date) - new Date(b.date));

  state.prevPrice = state.lastPrice;
  state.prices    = points;
  state.lastPrice = points[points.length - 1].price;
  state.lastFetch = Date.now();

  console.log('[App] Parsed', points.length, 'points. Latest:', state.lastPrice);

  /* Keep SW config cache in sync with latest price */
  saveConfigToCache({ lastPrice: state.lastPrice });

  saveState();
  renderAll();
  checkThresholds();
}

/* ═══════════════════════════════════════════════
   THRESHOLD CHECK
═══════════════════════════════════════════════ */
function checkThresholds() {
  if (!state.lastPrice) return;
  const t     = state.thresholds;
  const price = state.lastPrice;
  const prev  = state.prevPrice;

  const msgs = [];
  if (t.priceAbove && price >= parseFloat(t.priceAbove))
    msgs.push(`📈 Price ₹${fmt(price)} crossed above ₹${fmt(t.priceAbove)}`);
  if (t.priceBelow && price <= parseFloat(t.priceBelow))
    msgs.push(`📉 Price ₹${fmt(price)} dropped below ₹${fmt(t.priceBelow)}`);
  if (t.pctRise && prev) {
    const pct = ((price - prev) / prev) * 100;
    if (pct >= parseFloat(t.pctRise)) msgs.push(`🚀 Rose ${pct.toFixed(2)}% → ₹${fmt(price)}`);
  }
  if (t.pctDrop && prev) {
    const pct = ((prev - price) / prev) * 100;
    if (pct >= parseFloat(t.pctDrop)) msgs.push(`⚠️ Fell ${pct.toFixed(2)}% → ₹${fmt(price)}`);
  }

  if (msgs.length) {
    console.log('[App] Thresholds triggered:', msgs);
  } else {
    console.log('[App] No thresholds triggered. price:', price, 'prev:', prev);
  }
}

/* ═══════════════════════════════════════════════
   POLLING SCHEDULER
═══════════════════════════════════════════════ */
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const ms = state.interval * 60 * 1000;
  console.log('[App] Polling every', state.interval, 'min');
  state.pollTimer = setInterval(() => {
    console.log('[App] Scheduled poll fired');
    fetchGoldData();
  }, ms);
}

/* ═══════════════════════════════════════════════
   CHART
═══════════════════════════════════════════════ */
function getFilteredPrices() {
  if (!state.prices.length) return [];
  const now    = Date.now();
  const cutoffs = { '1M': 31, '3M': 92, '6M': 183 };
  const days   = cutoffs[state.activeRange] || 183;
  const cutoff = now - days * 86400000;
  const filtered = state.prices.filter(p => new Date(p.date).getTime() >= cutoff);
  return filtered.length >= 2 ? filtered : state.prices.slice(-30);
}

function buildChart() {
  const ctx = document.getElementById('priceChart');
  if (!ctx) return;
  const pts       = getFilteredPrices();
  const lineColor = '#B8741A';
  const fillColor = 'rgba(184,116,26,0.07)';
  const gridColor = 'rgba(0,0,0,0.05)';
  const tickColor = 'rgba(0,0,0,0.35)';

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels:   pts.map(p => p.date),
      datasets: [{
        data:                      pts.map(p => p.price),
        borderColor:               lineColor,
        borderWidth:               1.5,
        pointRadius:               0,
        pointHoverRadius:          4,
        pointHoverBackgroundColor: lineColor,
        fill:                      true,
        backgroundColor:           fillColor,
        tension:                   0.35
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction:         { mode: 'index', intersect: false },
      elements:            { point: { radius: 0 } },
      plugins: {
        legend:  { display: false },
        tooltip: {
          backgroundColor: '#ffffff',
          borderColor:     'rgba(0,0,0,0.1)',
          borderWidth:     1,
          titleColor:      '#7a7068',
          bodyColor:       '#1c1814',
          bodyFont:        { size: 13, weight: '500' },
          padding:         10,
          callbacks: {
            title: items => fmtDate(items[0].label),
            label: ctx   => ' ₹' + fmt(ctx.parsed.y)
          }
        }
      },
      scales: {
        x: { display: false },
        y: {
          display:  true,
          position: 'right',
          grid:     { color: gridColor, drawTicks: false },
          border:   { display: false },
          ticks: {
            font:          { size: 10 },
            color:         tickColor,
            maxTicksLimit: 5,
            callback:      v => '₹' + (v / 1000).toFixed(1) + 'k',
            padding:       6
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
  chart.data.labels             = pts.map(p => p.date);
  chart.data.datasets[0].data   = pts.map(p => p.price);
  chart.update('active');
  updateAxisLabels();
}

function updateAxisLabels() {
  const container = el('chartAxisLabels');
  if (!container) return;
  const pts   = getFilteredPrices();
  if (pts.length < 2) return;
  const spans = container.querySelectorAll('span');
  spans.forEach((span, i) => {
    const idx = Math.round(i * (pts.length - 1) / (spans.length - 1));
    span.textContent = fmtDateShort(pts[idx].date);
  });
}

/* ═══════════════════════════════════════════════
   RENDER
═══════════════════════════════════════════════ */
function renderAll() {
  renderMetrics();
  updateChart();
  renderLastUpdated();
}

function renderMetrics() {
  const pts = state.prices;
  if (!pts.length) return;

  const latest  = pts[pts.length - 1].price;
  const weekAgo = pts.length >= 7 ? pts[pts.length - 7].price : pts[0].price;
  const dayAgo  = pts.length >= 2 ? pts[pts.length - 2].price : latest;

  const todayPct = ((latest - dayAgo) / dayAgo * 100);
  const weekDiff = latest - weekAgo;

  el('currentPrice').textContent = '₹' + fmt(latest);
  const todayEl = el('todayChange');
  todayEl.textContent = (todayPct >= 0 ? '+' : '') + todayPct.toFixed(2) + '% today';
  todayEl.className   = 'metric-change ' + (todayPct >= 0 ? 'up' : 'down');

  el('weekChange').textContent = (weekDiff >= 0 ? '+₹' : '−₹') + fmt(Math.abs(weekDiff));
  el('weekFrom').textContent   = 'from ₹' + fmt(weekAgo);
}

function renderLastUpdated() {
  const e2 = el('lastUpdated');
  if (!e2) return;
  e2.textContent = state.lastFetch ? 'Updated ' + fmtTs(state.lastFetch) : 'Not yet fetched';
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
    console.warn('[App] Notifications not supported');
    return false;
  }
  console.log('[App] Current permission:', Notification.permission);
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  console.log('[App] Permission result:', result);
  return result === 'granted';
}

async function registerPeriodicSync(reg) {
  if (!('periodicSync' in reg)) {
    console.log('[App] Periodic Background Sync not supported in this browser');
    return;
  }
  try {
    await reg.periodicSync.register('gold-price-check', {
      minInterval: 30 * 60 * 1000  /* 30 minutes */
    });
    console.log('[App] Periodic sync registered ✓');
  } catch (e) {
    console.warn('[App] periodicSync.register failed:', e.message,
      '(PWA must be installed for this to work)');
  }
}

/* ═══════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════ */
function wireEvents() {
  el('btnRefresh').addEventListener('click', () => {
    console.log('[App] Manual refresh');
    fetchGoldData();
  });

  el('btnSave').addEventListener('click', async () => {
    state.thresholds.priceAbove = el('inputPriceAbove').value.trim();
    state.thresholds.priceBelow = el('inputPriceBelow').value.trim();
    state.thresholds.pctRise    = el('inputPctRise').value.trim();
    state.thresholds.pctDrop    = el('inputPctDrop').value.trim();
    state.interval = parseInt(el('selectInterval').value, 10) || 60;

    saveState();
    startPolling();

    /* Push thresholds to SW via Cache API */
    await saveConfigToCache({ thresholds: state.thresholds });

    /* Also message the SW so it can log the update */
    try {
      const reg = await navigator.serviceWorker.ready;
      reg.active && reg.active.postMessage({
        type: 'SAVE_CONFIG',
        config: { thresholds: state.thresholds }
      });
    } catch {}

    console.log('[App] Thresholds saved:', state.thresholds);
    showSavedFeedback();
  });

  el('toggleNotify').addEventListener('click', async () => {
    if (!state.notifyEnabled) {
      const granted = await requestNotificationPermission();
      if (!granted) {
        console.warn('[App] Notification permission denied');
        return;
      }
      state.notifyEnabled = true;

      try {
        const reg = await navigator.serviceWorker.ready;
        console.log('[App] SW ready, active state:', reg.active?.state);

        /* Register periodic sync (works when PWA is installed) */
        await registerPeriodicSync(reg);

        /* Send test notification */
        reg.active.postMessage({ type: 'NOTIFY_TEST' });
        console.log('[App] NOTIFY_TEST sent to SW');
      } catch (e) {
        console.error('[App] SW not ready:', e);
      }
    } else {
      state.notifyEnabled = false;
      console.log('[App] Notifications disabled');
    }
    saveState();
    updateToggleUI();
  });

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
  const btn  = el('btnSave');
  const orig = btn.textContent;
  btn.textContent   = '✓ Saved';
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
   SERVICE WORKER REGISTRATION
═══════════════════════════════════════════════ */
async function registerSW() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[App] ServiceWorker not supported');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    console.log('[App] SW registered, scope:', reg.scope);

    /* Listen for price updates pushed from the SW */
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'PRICE_UPDATE') {
        console.log('[App] SW pushed price update:', e.data.price);
        /* Re-fetch full data to refresh the UI */
        fetchGoldData();
      }
    });
  } catch (e) {
    console.error('[App] SW registration failed:', e);
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
  try { return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }); }
  catch { return str; }
}

function fmtDateShort(str) {
  try { return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
  catch { return str; }
}

function fmtTs(ts) {
  const d   = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return isToday
    ? 'Today, ' + time
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + time;
}

/* ═══════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[App] Boot');
  loadState();
  populateUI();
  wireEvents();
  await registerSW();

  if (state.prices.length) {
    renderAll();
    buildChart();
  }

  await fetchGoldData();

  if (!chart) buildChart();

  startPolling();
});
