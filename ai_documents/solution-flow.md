# Latiabetina WhatsApp Bot — Solution Flow & Relevant Files

**Service:** Node.js gateway that bridges Laravel (`latiabetina.com`) → WhatsApp via `whatsapp-web.js` + Puppeteer/Chrome.
**Listening:** `http://0.0.0.0:3007` (`server.js:690-695`)
**Stack:** `express@4`, `whatsapp-web.js@1.34.7`, `puppeteer@24.38.0` (transitive), `qrcode`, `LocalAuth`
**Last fix:** 2026-08-25 — Chrome Not Found / FAILED (dotenv + cache + diagnostics)

---

## 1. Relevant Files

| File | Purpose | Key lines |
|------|---------|-----------|
| `server.js` | Entire runtime: Express API, WhatsApp client, auth, watchdog, QR rendering | `server.js:1-695` |
| `package.json` | Dependencies & scripts (`start`, `dev --watch`) | `package.json:1-26` |
| `.env` | Runtime config: `PORT`, `HOST`, `CLIENT_ID`, `API_PASSWORD`, `CHROME_BIN` | `.env:1-6` (now includes `CHROME_BIN` with Windows path) |
| `.env.production` | Prod override (if exists); `server.js:9-12` now loads `.env` + `.env.production` merged | `server.js:9-12` |
| `ecosystem.config.cjs` | PM2 config (`cwd: __dirname`, `NODE_ENV=production`) | `ecosystem.config.cjs:1-22` |
| `.wwebjs_auth/` | `LocalAuth` store (gitignored). `session-*/` + `last_number.txt` persisted on `ready` | `server.js:20`, `server.js:338-343` |
| `.wwebjs_cache/` | `WebVersionCache` local HTML cache (gitignored) | `server.js:22` |
| `test_auth.js` | Manual fetch test for `/qr` auth | `test_auth.js:1-22` |
| `.gitignore` | Excludes `node_modules/`, `.env`, `.wwebjs_auth/`, `.wwebjs_cache/`, `*.log` | `.gitignore:1-5` |
| `ai_documents/` | Architecture docs | — |

Empty/scaffolded: `scripts/` and `.github/workflows/` exist but contain 0 files.

**Transitive deps (not committed but required at runtime):**

- `node_modules/whatsapp-web.js/src/Client.js:429-467` — `Client.initialize()` launches Puppeteer, injects WWebJS, binds `pupPage` events.
- `node_modules/puppeteer-core/lib/cjs/puppeteer/node/BrowserLauncher.js:301-346` — `resolveExecutablePath()` that threw `Could not find Chrome (ver. ...)` when cache empty.
- `node_modules/puppeteer/lib/cjs/puppeteer/getConfiguration.js:93-124` — resolves `cacheDirectory` → `C:\Users\...\ .cache\puppeteer` (empty before fix).

---

## 2. High-Level Flow

```
Laravel (church member created)
    │
    │ POST https://<bot-host>:3007/api/send-message
    │  Header: x-api-password: <API_PASSWORD>
    │  Body: { phone, message }  or  /api/send-image { phone, mediaUrl|base64, caption }
    ▼
Express (server.js:77-79)  ──cors + json──► authMiddleware (server.js:81-221)
    │                                           │ rejects 401 or renders login HTML (server.js:91-217)
    │                                           ▼
    │                                    route handler
    │                                    checks clientStatus !== 'READY' → 503 (server.js:394-400)
    │                                    normalizes phone →  digits@c.us (server.js:389-392)
    │                                    client.sendMessage() via whatsapp-web.js
    ▼
whatsapp-web.js Client (server.js:270-285)
    │  LocalAuth (server.js:270) persists session to .wwebjs_auth/
    │  Puppeteer launch (server.js:272-283) with resolved chromePath (see §4)
    ▼
Chrome/Chromium headless → https://web.whatsapp.com → WWebJS injection
```

**Outbound only** — bot does not listen for inbound `message` events; only `qr`, `ready`, `authenticated`, `auth_failure`, `disconnected`, `loading_screen`.

### Integration point (Laravel)

Laravel `.env`:
```
WHATSAPP_BOT_URL=http://127.0.0.1:3007   # README.md:48
WHATSAPP_BOT_PASSWORD=<same as API_PASSWORD>
```
Laravel calls `POST $WHATSAPP_BOT_URL/api/send-message` with `x-api-password` header after member creation.

---

## 3. Client Lifecycle & State Machine

State variable: `clientStatus` (`server.js:34`), plus `lastLaunchError` (`server.js:232`) surfaced on `/qr` + `/status`

```
INITIALIZING ──watchdog start (180s)──► LOADING (server.js:316-321, 52-75)
    │                                      │
    │ qr event (server.js:348-354)         │ watchdog timeout → RESTARTING → wipe? → re-initialize
    ▼                                      ▼
QR_RECEIVED (lastQr set, terminal + /qr)  AUTHENTICATED (server.js:323-328)
    │                                      │
    └──────────► READY (server.js:330-346) ◄┘
                 - clears watchdog
                 - persists wid to .wwebjs_auth/last_number.txt
                 - nulls lastQr

Error branches:
  auth_failure (server.js:356-367) → AUTH_FAILURE → wipeSession() (server.js:40-46) → 3s → INITIALIZING → safeInitialize()
  disconnected (server.js:369-383) → DISCONNECTED → exponential backoff 5s*2^n max 60s → INITIALIZING → safeInitialize()
  Chrome launch failure → FAILED (server.js:288-296, 298-314) → /qr shows Chrome Error card with lastLaunchError (server.js:480-524)
```

**Watchdog** (`server.js:52-75`): if stuck in `LOADING`/`INITIALIZING` for `LOADING_TIMEOUT_MS=180_000` (3 min, Pi-tuned), increments `reconnectAttempts`; after `MAX_RECONNECT_ATTEMPTS=3` wipes session, then `RESTARTING` → `safeInitialize()`.

**`safeInitialize()`** (`server.js:287-296`): wraps `client.initialize()` with `.catch()` capturing `lastLaunchError`, distinguishing `Could not find Chrome` vs `Failed to launch` (permissions/lock). Global `unhandledRejection`/`uncaughtException` guards at `server.js:298-314` also set `FAILED` without crashing.

---

## 4. Chrome Resolution (Fix for `BrowserLauncher.js:334` + FAILED)

**Root cause (2026-08-24):** `puppeteer: { executablePath: process.env.CHROME_BIN || undefined }` (old `server.js:220`) left `undefined` when `.env` had no `CHROME_BIN`. `puppeteer-core` fell back to `C:\Users\...\ .cache\puppeteer` (empty/corrupted → `Browser was not found at ...chrome-win64/chrome.exe` or `Could not find Chrome (ver. undefined)`). Second failure (2026-08-25): `dotenv` loaded only `.env.production` when `NODE_ENV=production`, so `CHROME_BIN` in `.env` was ignored → `chromePath` undefined even on Windows → `/qr` showed generic `Chrome Not Found` with `lastLaunchError = null`.

**Fix — resolver (`server.js:4-268`):**

1. `import { createRequire } from 'module'` + `import { execSync }` (`server.js:4-5, 231`).
2. `.env` loading fixed (`server.js:9-12`): always load `.env`, then override with `.env.production` if `NODE_ENV=production` (so `CHROME_BIN` in `.env` is not ignored under PM2).
3. `resolveChromePath()` (`server.js:232-268`):
   - Checks `CHROME_BIN`, `PUPPETEER_EXECUTABLE_PATH`, then deduped list: Windows `C:\Program Files\...\chrome.exe` + `%PROGRAMFILES%` variants, `Edge` as fallback, Linux `/usr/bin/google-chrome-stable` `/usr/bin/chromium-browser` `/snap/bin/chromium`, macOS `Google Chrome.app`.
   - Dynamic `where` (win) / `which` (linux) lookup adds any Chrome/Edge on PATH.
   - Logs diagnostics for every candidate, warns if `puppeteer.executablePath()` computed but missing, returns first `fs.existsSync` match.
   - `chromePath` logged (`server.js:270-282`); if found, hint to persist `CHROME_BIN` is shown; if not, `lastLaunchError` seeded.
4. `executablePath: chromePath` (`server.js:284`) with hardened args (`server.js:285-292`): `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--no-first-run`, `--no-zygote`, `--disable-extensions`.

**Fix — error surfacing (`server.js:232, 287-314, 480-524, 653-656`):**

- `lastLaunchError` global captures full `err.message + stack` in `safeInitialize().catch`.
- `unhandledRejection`/`uncaughtException` also set `FAILED` + `lastLaunchError`.
- `/qr` when `FAILED` now renders `<pre>lastLaunchError</pre>` + `chromePath` tried + links to `/status` and `/reset`.
- `/status` now returns `{ status, hasQr, chromePath, lastError, platform }` for programmatic debugging.

**Fix — persistence:**

- `.env:6` now sets `CHROME_BIN=C:\Program Files\Google\Chrome\Application\chrome.exe` (Windows dev). On Pi, set `CHROME_BIN=/usr/bin/chromium-browser` in `.env` or `.env.production`; if unset, auto-detection still finds Linux candidates.
- `ecosystem.config.cjs:13-18` keeps `NODE_ENV=production` but no longer needs hardcoded `CHROME_BIN` because `.env` is now loaded even in production.
- Corrupted `C:\Users\chemo\.cache\puppeteer\chrome\win64-146.0.7680.31` (missing `chrome.exe`, `end of central directory` error) was cleared; system Chrome is now preferred so cache is optional. If cache needed, run `npx puppeteer browsers install chrome` after clearing.

**Verification:**

- `NODE_ENV=production node server.js` → `Env candidate exists: C:\Program Files\...\chrome.exe` + `Using executable: ...` + `[QR] QR code received` (previously showed `FAILED` with generic card).
- `curl http://127.0.0.1:3007/status?pw=...` → `{"status":"QR_RECEIVED","hasQr":true,"chromePath":"C:\\...\\chrome.exe","lastError":null}`.
- Failure case now shows real error (e.g., `Browser was not found at ...` vs `Failed to launch ... EACCES`) instead of generic text.

---

## 5. HTTP API

All routes behind `authMiddleware` (`server.js:81-221`): checks `x-api-password` header or `?pw=` query; 401 JSON for API clients, HTML login card for browsers (`Accept: text/html` or `path==/qr`).

| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| `POST` | `/api/send-message` | yes | `phone`, `message` required; `clientStatus!==READY` → 503; `normalizePhone()` (`server.js:389-392`) → `sendMessage()` |
| `POST` | `/api/send-image` | yes | `phone` + `mediaUrl` or `base64`/`mimetype`/`filename`; `MessageMedia.fromUrl` or `new MessageMedia` |
| `GET` | `/qr` | yes | `READY` → success card; `FAILED` → **detailed** error card with `chromePath` + `lastLaunchError` + fix hints (`server.js:455-547`); `!lastQr` → spinner polling 2s; else QR `toDataURL` card polling 30s |
| `GET` | `/logout` | yes | `client.logout()` → `wipeSession()` → 1s → `safeInitialize()` (`server.js:596-612`) |
| `GET` | `/reset` | yes | Manual recovery: `client.destroy()` → `wipeSession()` → 2s → `safeInitialize()` (`server.js:615-651`) |
| `GET` | `/status` | yes | `{ status, hasQr, chromePath, lastError, platform }` JSON (`server.js:653-656`) |
| `GET` | `/me` | yes | If `READY` → `client.info.wid.user`; else fallback reads `.wwebjs_auth/last_number.txt` (`server.js:658-688`) |

`normalizePhone` (`server.js:389-392`): strip non-digits, append `@c.us`.

---

## 6. Configuration

`server.js:9-12` now loads **both**: `.env` always, then `.env.production` (override) if `NODE_ENV=production` — so `CHROME_BIN` in `.env` is not lost under PM2.

| Var | Default | Used |
|-----|---------|------|
| `PORT` | `3007` | `server.js:690` |
| `HOST` | `0.0.0.0` | `server.js:691` |
| `CLIENT_ID` | `latiabetina-bot` | `server.js:20`, `270` |
| `API_PASSWORD` | `admin123` | `server.js:31` |
| `CHROME_BIN` / `PUPPETEER_EXECUTABLE_PATH` | auto-detected if unset | `server.js:235-236` (+ dynamic `where`/`which`) |
| `NODE_ENV` | — | selects `.env.production` overlay |

`.env:6` currently pins Windows Chrome; on Linux/Pi change to `CHROME_BIN=/usr/bin/chromium-browser` (or leave unset for auto-detection). `ecosystem.config.cjs:13-18` keeps `NODE_ENV=production`; no hardcoded `CHROME_BIN` needed.

---

## 7. Operational Notes

- **First run:** `npm install` → `npm start` → scan QR in terminal (`qrcode-terminal`) or `http://<host>:3007/qr?pw=<API_PASSWORD>`. Session persists via `.wwebjs_auth/`.
- **PM2:** `pm2 start ecosystem.config.cjs` (or `pm2 restart WhatsappBot --update-env`). `cwd: __dirname` (`ecosystem.config.cjs:6`) keeps `LocalAuth` absolute. `NODE_ENV=production` now correctly overlays `.env.production` on `.env`.
- **Logs:** `pm2 logs WhatsappBot` or `console.log` states. `README` still references `:3002` but actual port is `:3007`.
- **If `/qr` shows FAILED:** visit `/status?pw=...` for JSON `{ lastError, chromePath }`; check `pm2 logs`. Common fixes:
  - Windows: `CHROME_BIN` must exist; reinstall Chrome if missing.
  - Pi: `sudo apt-get install -y chromium-browser` then `CHROME_BIN=/usr/bin/chromium-browser` in `.env.production`.
  - Cache corrupted (`end of central directory`): `rm -rf ~/.cache/puppeteer/chrome` then `npx puppeteer browsers install chrome`.
- **Security:** `API_PASSWORD` is UUID in `.env:4`; `.gitignore:2` excludes `.env`.
- **Testing:** `node test_auth.js` probes `/qr` 401 vs 200.

---

## 8. Change Log

- **2026-08-24:** Fixed `Could not find Chrome` by adding `resolveChromePath()` + `safeInitialize()` + `unhandledRejection` guards + `FAILED` UI + Chromium args.
- **2026-08-25:** Fixed production `FAILED` (`NODE_ENV=production` ignored `.env` → `CHROME_BIN` lost). Changed `server.js:9-12` to load `.env` + `.env.production` merged. Added `lastLaunchError`, detailed `/qr` error card (`server.js:480-524`) + `/status` diagnostics (`chromePath`, `lastError`), dynamic `where`/`which` lookup, Edge fallback, corrupted cache cleanup. Verified `NODE_ENV=production` + `CHROME_BIN` now yields `Env candidate exists` and `QR_RECEIVED`.

