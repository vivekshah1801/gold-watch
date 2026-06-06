/* Gold Watch — Service Worker v1.0.3 */
const CACHE = 'gold-watch-v1.0.3';
const STATIC = ['/', '/index.html'];

/* ── Install ─────────────────────────────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

/* ── Activate ────────────────────────────────────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch (network-first for API, cache for static) */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('allorigins') || url.hostname.includes('zerodhafundhouse') || url.hostname.includes('corsproxy')) {
    /* API calls — always network, never cache */
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

/* ── Messages from main thread ───────────────────── */
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'CHECK_ALERT') {
    const { price, prevPrice, thresholds, log } = e.data;
    const triggered = evaluateThresholds(price, prevPrice, thresholds);
    if (triggered.length > 0) {
      triggered.forEach(t => fireNotification(t.title, t.body, t.tag));
    }
    e.source && e.source.postMessage({ type: 'CHECK_RESULT', triggered });
  }
  if (e.data && e.data.type === 'NOTIFY_TEST') {
    fireNotification('Gold Watch', 'Notifications are working ✓', 'test');
  }
});

function evaluateThresholds(price, prevPrice, t) {
  const results = [];
  if (!price || !t) return results;

  /* Absolute price above threshold */
  if (t.priceAbove && price >= t.priceAbove) {
    results.push({
      title: '📈 Price target hit',
      body: `GOLD995 is ₹${fmt(price)} — above your ₹${fmt(t.priceAbove)} target`,
      tag: 'price-above'
    });
  }

  /* Absolute price below threshold */
  if (t.priceBelow && price <= t.priceBelow) {
    results.push({
      title: '📉 Price dropped below target',
      body: `GOLD995 is ₹${fmt(price)} — below your ₹${fmt(t.priceBelow)} floor`,
      tag: 'price-below'
    });
  }

  /* % rise from previous check */
  if (t.pctRise && prevPrice) {
    const pct = ((price - prevPrice) / prevPrice) * 100;
    if (pct >= t.pctRise) {
      results.push({
        title: '🚀 Gold surged',
        body: `GOLD995 rose ${pct.toFixed(2)}% to ₹${fmt(price)}`,
        tag: 'pct-rise'
      });
    }
  }

  /* % drop from previous check */
  if (t.pctDrop && prevPrice) {
    const pct = ((prevPrice - price) / prevPrice) * 100;
    if (pct >= t.pctDrop) {
      results.push({
        title: '⚠️ Gold dropped',
        body: `GOLD995 fell ${pct.toFixed(2)}% to ₹${fmt(price)}`,
        tag: 'pct-drop'
      });
    }
  }

  return results;
}

function fireNotification(title, body, tag) {
  self.registration.showNotification(title, {
    body,
    tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    requireInteraction: false,
    data: { url: self.location.origin }
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});

function fmt(n) {
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
