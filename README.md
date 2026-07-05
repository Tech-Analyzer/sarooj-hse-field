# Sarooj HSE — Field PWA

Offline field-capture companion for the Sarooj HSE Platform. Installs to a phone,
works with **zero signal**, and syncs observations to the **same Google Sheet** the
main app uses — via the Apps Script `doPost` sync endpoint.

## Files
```
pwa/
  index.html          app shell
  styles.css          styles (navy/brass, mobile-first)
  config.js           ← SWAP the API_URL here
  app.js              app logic (O2 shell; O3 adds capture + IndexedDB)
  service-worker.js   offline caching of the shell
  manifest.json       PWA manifest (installable)
  icons/icon.svg      app icon
```

## Deploy to GitHub Pages (free)
1. Create a new GitHub repo (e.g. `sarooj-hse-field`).
2. Put the **contents of this `pwa/` folder at the repo root** (index.html at the top).
3. Repo **Settings → Pages → Build and deployment → Source: `main` branch / root**.
4. Your app URL will be `https://<user>.github.io/sarooj-hse-field/`.
5. **Edit `config.js`** and set `API_URL` to your Apps Script web-app **/exec** URL
   (Deploy → Manage deployments → New version → copy the Web app URL).

## Notes
- Must be served over **HTTPS** (GitHub Pages is) for service workers / install.
- On first use the officer logs in **while online** (O5) so the app can cache their
  identity + the engineer list + sites for offline capture.
- **Icons:** a single SVG is provided. For the widest install support you may later add
  `icon-192.png` and `icon-512.png` (export from `icon.svg`) and list them in `manifest.json`.

## Build status — COMPLETE
- ✅ O1 — sync endpoint (`Sync.js` in the Apps Script project)
- ✅ O2 — installable, offline-caching shell
- ✅ O3 — login + observation capture form + IndexedDB queue + photos/GPS
- ✅ O4 — sync hardening (backoff retries, per-record status, CORS fallback)
- ✅ O5 — device-token identity (no PIN stored; revocable via the `DeviceTokens` sheet tab)

## Revoking a device
Open the master workbook → `DeviceTokens` tab → set that row's `Revoked` to `TRUE`.
The phone's next sync fails auth and prompts a fresh sign-in.
