# Gold Watch 🪙

A lightweight PWA that tracks Zerodha Fundhouse **GOLD995** price and sends you a notification when your price thresholds are hit.

**Live demo:** `https://<your-username>.github.io/gold-watch/`

---

## Features

- 📈 Live GOLD995 price via Zerodha Fundhouse API
- 🔔 Push notifications via Service Worker (iOS 16.4+, Android, desktop)
- 📊 Price history sparkline with 1M / 3M / 6M range toggle
- ⚙️ Four alert types: price above, price below, % rise, % drop
- 🕐 Configurable polling: 30min → 24hr
- 💾 All data stored locally in `localStorage` — nothing leaves your device except the API fetch
- 📦 Zero dependencies — vanilla JS, Chart.js (CDN), no framework
- 🌐 Works offline (Service Worker cache)

---

## Deploy to GitHub Pages (5 minutes)

### Step 1 — Fork or upload

```bash
git clone https://github.com/YOUR_USERNAME/gold-watch.git
cd gold-watch
```

Or simply upload the files directly via GitHub's web UI.

### Step 2 — Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages**
2. Under **Source**, select **GitHub Actions**
3. Push any commit (or trigger manually via Actions tab)

### Step 3 — Open the URL

```
https://YOUR_USERNAME.github.io/gold-watch/
```

That's it. The GitHub Actions workflow at `.github/workflows/deploy.yml` handles deployment automatically on every push to `main`.

---

## How it works

```
PWA (your phone)
  │
  │── On open / every N minutes ──▶ allorigins.win (CORS proxy)
  │                                        │
  │                                        ▼
  │                               api.zerodhafundhouse.com
  │                                        │
  │◀─────────── JSON price data ──────────┘
  │
  ├── Parse & store in localStorage
  ├── Compare against thresholds
  └── If triggered → Service Worker → Push notification
```

**Why the proxy?** Browsers block direct cross-origin API calls (CORS). The proxy fetches on your behalf, server-side, and adds CORS headers. If the primary proxy (`allorigins.win`) is down, the app automatically retries via `corsproxy.io`.

---

## Add to Home Screen

- **Android (Chrome):** tap the "Add to home screen" banner or ⋮ menu → "Install app"
- **iOS (Safari):** tap Share → "Add to Home Screen"

Once installed, the app runs like a native app. On iOS 16.4+, notifications will work after granting permission inside the app.

---

## File structure

```
gold-watch/
├── index.html          # Single-page app — all UI
├── app.js              # Logic: fetch, storage, chart, alerts, polling
├── sw.js               # Service Worker: caching + notifications
├── manifest.json       # PWA manifest
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── .github/
    └── workflows/
        └── deploy.yml  # Auto-deploy to GitHub Pages
```

---

## Local development

Just open `index.html` in a browser. For Service Worker support, serve with a local server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

---

## Version history

| Version | Notes |
|---------|-------|
| v1.0.3  | Initial release — all features |

---

*Made with 🤖 by Claude while [Vivek Shah](https://github.com/vivekshah1801) sips his tea.*
