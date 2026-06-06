/* Gold Watch — Service Worker v3.0.0
   - Periodic Background Sync: fetch data.json, check thresholds, fire notifications
   - Config shared with main thread via Cache API (CFG_CACHE)
   - Extensive console logging for debugging
*/

const CACHE     = 'gold-watch-v3.0.0';
const CFG_CACHE = 'gold-watch-config';
const CFG_KEY   = '/gw-config';
const STATIC    = ['/', '/index.html'];
const DATA_URL  = new URL('./data.json', self.location.href).href;

/* ── Config helpers (Cache API shared with main thread) ── */
async function getConfig() {
  try {
    const cache = await caches.open(CFG_CACHE);
    const res   = await cache.match(CFG_KEY);
    return res ? await res.json() : {};
  } catch { return {}; }
}

async function setConfig(patch) {
  try {
    const cache   = await caches.open(CFG_CACHE);
    const current = await getConfig();
    const updated = Object.assign({}, current, patch);
    await cache.put(CFG_KEY, new Response(JSON.stringify(updated), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (e) { console.error('[SW] setConfig failed:', e); }
}

/* ── Install ─────────────────────────────────────── */
self.addEventListener('install', e => {
  console.log('[SW] Installing v3.0.0');
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate ────────────────────────────────────── */
self.addEventListener('activate', e => {
  console.log('[SW] Activating v3.0.0');
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== CFG_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch: network-only for data.json, cache for static ── */
self.addEventListener('fetch', e => {
  if (e.request.url.includes('data.json')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

/* ── Periodic Background Sync ────────────────────── */
self.addEventListener('periodicsync', e => {
  console.log('[SW] periodicsync fired, tag:', e.tag);
  if (e.tag === 'gold-price-check') {
    e.waitUntil(checkGoldAndNotify('periodicsync'));
  }
});

/* ── Messages from main thread ───────────────────── */
self.addEventListener('message', e => {
  const type = e.data && e.data.type;
  console.log('[SW] Message received:', type);

  if (type === 'SAVE_CONFIG') {
    setConfig(e.data.config).then(() =>
      console.log('[SW] Config saved:', JSON.stringify(e.data.config))
    );
  }

  if (type === 'NOTIFY_TEST') {
    fireNotification('Gold Watch ✓', 'Push notifications are working!', 'test')
      .then(() => console.log('[SW] Test notification sent'))
      .catch(err => console.error('[SW] Test notification failed:', err));
  }

  if (type === 'MANUAL_CHECK') {
    e.waitUntil(checkGoldAndNotify('manual'));
  }
});

/* ── Core check ──────────────────────────────────── */
async function checkGoldAndNotify(source) {
  console.log('[SW] checkGoldAndNotify — source:', source);

  const config = await getConfig();
  console.log('[SW] Config:', JSON.stringify(config));

  const thresholds = config.thresholds;
  if (!thresholds || Object.values(thresholds).every(v => !v)) {
    console.log('[SW] No thresholds set, skipping');
    return;
  }

  /* Fetch fresh data.json */
  let data;
  try {
    const res = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
    console.log('[SW] data.json fetched OK');
  } catch (err) {
    console.error('[SW] Fetch data.json failed:', err.message);
    return;
  }

  /* Parse latest price */
  const points = data?.data?.points;
  if (!Array.isArray(points) || !points.length) {
    console.warn('[SW] No points in data.json');
    return;
  }
  const price = parseFloat(points[points.length - 1].val);
  if (!price || isNaN(price)) {
    console.warn('[SW] Invalid price parsed:', price);
    return;
  }

  const prevPrice = config.lastPrice || null;
  console.log('[SW] price:', price, '| prevPrice:', prevPrice);

  /* Persist latest price */
  await setConfig({ lastPrice: price });

  /* Push price update to any open clients */
  const clientList = await self.clients.matchAll({ type: 'window' });
  clientList.forEach(c => c.postMessage({ type: 'PRICE_UPDATE', price }));
  console.log('[SW] Notified', clientList.length, 'open client(s)');

  /* Evaluate and fire notifications */
  const triggered = evaluateThresholds(price, prevPrice, thresholds);
  console.log('[SW] Triggered alerts:', triggered.length, triggered.map(t => t.tag));
  for (const t of triggered) {
    await fireNotification(t.title, t.body, t.tag);
  }
}

/* ── Threshold evaluation ─────────────────────────── */
function evaluateThresholds(price, prevPrice, t) {
  const results = [];
  if (!price || !t) return results;

  if (t.priceAbove && price >= parseFloat(t.priceAbove)) {
    results.push({ title: '📈 Price target hit',
      body: `GOLD995 ₹${fmt(price)} — above ₹${fmt(t.priceAbove)} target`, tag: 'price-above' });
  }
  if (t.priceBelow && price <= parseFloat(t.priceBelow)) {
    results.push({ title: '📉 Price below floor',
      body: `GOLD995 ₹${fmt(price)} — below ₹${fmt(t.priceBelow)} floor`, tag: 'price-below' });
  }
  if (t.pctRise && prevPrice) {
    const pct = ((price - prevPrice) / prevPrice) * 100;
    if (pct >= parseFloat(t.pctRise)) {
      results.push({ title: '🚀 Gold surged',
        body: `GOLD995 rose ${pct.toFixed(2)}% → ₹${fmt(price)}`, tag: 'pct-rise' });
    }
  }
  if (t.pctDrop && prevPrice) {
    const pct = ((prevPrice - price) / prevPrice) * 100;
    if (pct >= parseFloat(t.pctDrop)) {
      results.push({ title: '⚠️ Gold dropped',
        body: `GOLD995 fell ${pct.toFixed(2)}% → ₹${fmt(price)}`, tag: 'pct-drop' });
    }
  }
  return results;
}

/* ── Fire notification ────────────────────────────── */
async function fireNotification(title, body, tag) {
  console.log('[SW] fireNotification:', tag, '| permission:', Notification.permission);
  if (Notification.permission !== 'granted') {
    console.warn('[SW] Notification blocked — permission:', Notification.permission);
    return;
  }
  try {
    await self.registration.showNotification(title, {
      body,
      tag,
      icon: new URL('./icons/icon-192.png', self.location.href).href,
      badge: new URL('./icons/icon-192.png', self.location.href).href,
      vibrate: [200, 100, 200],
      requireInteraction: false,
      data: { url: new URL('./', self.location.href).href }
    });
    console.log('[SW] Notification shown OK:', tag);
  } catch (err) {
    console.error('[SW] showNotification threw:', err);
  }
}

/* ── Notification click ───────────────────────────── */
self.addEventListener('notificationclick', e => {
  console.log('[SW] Notification clicked:', e.notification.tag);
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow(target);
    })
  );
});

function fmt(n) {
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
