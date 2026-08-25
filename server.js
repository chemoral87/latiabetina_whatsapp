import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Load .env first, then .env.production overrides if NODE_ENV=production (so CHROME_BIN in .env is not ignored)
dotenv.config({ path: path.join(__dirname, '.env') });
if (process.env.NODE_ENV === 'production') {
  dotenv.config({ path: path.join(__dirname, '.env.production'), override: true });
}
import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import fs from 'fs';

const { Client, LocalAuth, MessageMedia } = pkg;

// ─── Config ────────────────────────────────────────────────────────────────
const CLIENT_ID       = process.env.CLIENT_ID || 'latiabetina-bot';
const AUTH_DIR        = path.join(__dirname, '.wwebjs_auth');  // absolute — survives PM2 cwd changes
const CACHE_DIR       = path.join(__dirname, '.wwebjs_cache'); // absolute — survives PM2 cwd changes

// How long (ms) to wait in LOADING before declaring it stuck and auto-resetting
// Raspberry Pi is slower than a VPS — give Chrome 3 min to start before wiping session
const LOADING_TIMEOUT_MS = 180_000; // 3 minutes
// Max reconnect attempts before giving up and wiping session
const MAX_RECONNECT_ATTEMPTS = 3;

// Load and verify API Password
const API_PASSWORD = process.env.API_PASSWORD || 'admin123';
console.log(`[AUTH] Security enabled with password: ${API_PASSWORD === 'admin123' ? 'admin123 (DEFAULT)' : '********'}`);

let lastQr = null;
let clientStatus = 'INITIALIZING'; // INITIALIZING, LOADING, READY, QR_RECEIVED, AUTH_FAILURE, DISCONNECTED
let reconnectAttempts = 0;
let loadingWatchdog = null;   // Timer handle for LOADING stuck detection

// ─── Session helpers ───────────────────────────────────────────────────────
function wipeSession() {
  console.log('[RECOVERY] Wiping stale session and cache...');
  [AUTH_DIR, CACHE_DIR].forEach(dir => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });
  console.log('[RECOVERY] Session wiped.');
}

function clearLoadingWatchdog() {
  if (loadingWatchdog) { clearTimeout(loadingWatchdog); loadingWatchdog = null; }
}

function startLoadingWatchdog() {
  clearLoadingWatchdog();
  loadingWatchdog = setTimeout(() => {
    if (clientStatus === 'LOADING' || clientStatus === 'INITIALIZING') {
      console.warn(`[WATCHDOG] Stuck in ${clientStatus} for ${LOADING_TIMEOUT_MS / 1000}s — auto-resetting session.`);
      reconnectAttempts++;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.warn('[WATCHDOG] Max reconnect attempts reached — wiping session for fresh QR.');
        wipeSession();
        reconnectAttempts = 0;
      }
      clientStatus = 'RESTARTING';
      lastQr = null;
      try { if (typeof client !== 'undefined' && client) client.destroy(); } catch (_) {}
      setTimeout(() => {
        if (typeof safeInitialize === 'function') safeInitialize();
        else client.initialize().catch(err => {
          console.error('[FATAL] Failed to launch Chrome:', err.message);
          clientStatus = 'FAILED'; clearLoadingWatchdog();
        });
      }, 2000);
    }
  }, LOADING_TIMEOUT_MS);
}

const app = express();
app.use(cors());
app.use(express.json());

const authMiddleware = (req, res, next) => {
  const providedPassword = req.headers['x-api-password'] || req.query.pw;

  if (providedPassword === API_PASSWORD) {
    return next();
  }

  // If accessing via browser without correct password, show the login page
  const isBrowserRequest = req.headers['accept']?.includes('text/html');
  
  if (isBrowserRequest || req.path === '/qr') {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Secure Access - WhatsApp Bot</title>
          <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
          <style>
            :root {
              --primary: #38bdf8;
              --bg: #0f172a;
              --card-bg: rgba(30, 41, 59, 0.7);
            }
            body { 
              background: radial-gradient(circle at top right, #1e293b, #0f172a);
              color: white; 
              font-family: 'Outfit', sans-serif; 
              display: flex; 
              align-items: center; 
              justify-content: center; 
              height: 100vh; 
              margin: 0; 
              overflow: hidden;
            }
            .login-card {
              background: var(--card-bg);
              backdrop-filter: blur(12px);
              padding: 3rem;
              border-radius: 2rem;
              border: 1px solid rgba(255, 255, 255, 0.1);
              width: 100%;
              max-width: 400px;
              text-align: center;
              box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
              animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
            }
            @keyframes slideUp {
              from { opacity: 0; transform: translateY(30px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .icon-wrapper {
              width: 80px;
              height: 80px;
              background: rgba(56, 189, 248, 0.1);
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0 auto 2rem;
              border: 1px solid rgba(56, 189, 248, 0.2);
            }
            h1 { font-weight: 600; margin-bottom: 0.5rem; font-size: 1.75rem; letter-spacing: -0.025em; }
            p { color: #94a3b8; margin-bottom: 2rem; font-size: 0.95rem; }
            .input-group { position: relative; margin-bottom: 1.5rem; }
            input {
              width: 100%;
              padding: 1rem 1.25rem;
              border-radius: 1rem;
              border: 1px solid rgba(255, 255, 255, 0.1);
              background: rgba(0, 0, 0, 0.2);
              color: white;
              box-sizing: border-box;
              font-size: 1rem;
              transition: all 0.3s;
              outline: none;
              text-align: center;
            }
            input:focus {
              border-color: var(--primary);
              box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.1);
              background: rgba(0, 0, 0, 0.3);
            }
            button {
              width: 100%;
              padding: 1rem;
              background: var(--primary);
              color: #0f172a;
              border: none;
              border-radius: 1rem;
              font-weight: 600;
              font-size: 1rem;
              cursor: pointer;
              transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }
            button:hover { 
              background: #7dd3fc; 
              transform: translateY(-2px);
              box-shadow: 0 10px 15px -3px rgba(56, 189, 248, 0.3);
            }
            button:active { transform: translateY(0); }
            .error { 
              background: rgba(248, 113, 113, 0.1);
              color: #f87171;
              padding: 0.75rem;
              border-radius: 0.75rem;
              margin-top: 1.5rem;
              font-size: 0.875rem;
              border: 1px solid rgba(248, 113, 113, 0.2);
              animation: shake 0.4s;
            }
            @keyframes shake {
              0%, 100% { transform: translateX(0); }
              25% { transform: translateX(-5px); }
              75% { transform: translateX(5px); }
            }
          </style>
        </head>
        <body>
          <div class="login-card">
            <div class="icon-wrapper">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            </div>
            <h1>Restricted Area</h1>
            <p>Please enter your credentials to access the WhatsApp gateway.</p>
            <form action="/qr" method="GET">
              <div class="input-group">
                <input type="password" name="pw" placeholder="Enter API Password" required autofocus>
              </div>
              <button type="submit">Verify & Access</button>
            </form>
            ${providedPassword ? '<div class="error">Authentication failed. Please verify your password.</div>' : ''}
          </div>
        </body>
      </html>
    `);
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid password' });
};

// ─── Chrome executable resolver ────────────────────────────────────────────
// whatsapp-web.js uses puppeteer under the hood. If executablePath is not
// set, puppeteer tries to use its own cache (C:\Users\...\ .cache\puppeteer)
// which is empty unless `npx puppeteer browsers install chrome` was run.
// On Windows we have system Chrome; on Raspberry Pi we have chromium.
// This resolver checks env vars first, then common install locations, then
// puppeteer's cached binary.
const _require = createRequire(import.meta.url);
import { execSync } from 'child_process';

let lastLaunchError = null; // surfaced on /qr and /status when FAILED

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES'] ? path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    // Edge (can run WhatsApp Web as fallback)
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env['PROGRAMFILES'] ? path.join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    // Linux / Pi
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);

  // Dynamic lookup via where/which (handles custom install locations + PATH)
  try {
    if (process.platform === 'win32') {
      const out = execSync('where chrome 2>nul || where chrome.exe 2>nul || where msedge 2>nul || where msedge.exe 2>nul', { encoding: 'utf8', timeout: 3000 });
      out.split(/\r?\n/).forEach(p => { const t = p.trim(); if (t) candidates.push(t); });
    } else {
      const out = execSync('which google-chrome-stable 2>/dev/null; which google-chrome 2>/dev/null; which chromium-browser 2>/dev/null; which chromium 2>/dev/null; which microsoft-edge 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      out.split(/\r?\n/).forEach(p => { const t = p.trim(); if (t) candidates.push(t); });
    }
  } catch {}

  // Deduplicate while preserving order
  const seen = new Set();
  const uniq = candidates.filter(p => p && !seen.has(p) && seen.add(p));

  for (const p of uniq) {
    try {
      if (p && fs.existsSync(p)) {
        // CHROME_BIN env pointing to missing file is a common misconfig — warn
        if ((process.env.CHROME_BIN && p === process.env.CHROME_BIN) || (process.env.PUPPETEER_EXECUTABLE_PATH && p === process.env.PUPPETEER_EXECUTABLE_PATH)) {
          console.log(`[CHROME] Env candidate exists: ${p}`);
        }
        return p;
      }
    } catch {}
  }

  // Log diagnostics if nothing found
  console.warn('[CHROME] No candidate found after checking:');
  uniq.forEach(p => {
    let exists = false;
    try { exists = fs.existsSync(p); } catch {}
    console.warn(`  - ${p} ${exists ? '(exists but not selected?)' : '(missing)'}`);
  });

  // Fallback: try puppeteer's bundled/cached Chrome (may be Chrome for Testing)
  try {
    const puppeteer = _require('puppeteer');
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) {
      console.log(`[CHROME] Using puppeteer cache: ${p}`);
      return p;
    } else if (p) {
      console.warn(`[CHROME] Puppeteer cache path computed but missing: ${p}`);
    }
  } catch (e) {
    console.warn(`[CHROME] Puppeteer cache lookup failed: ${e.message}`);
  }

  return undefined;
}

const chromePath = resolveChromePath();
if (chromePath) {
  console.log(`[CHROME] Using executable: ${chromePath}`);
  // Persist to .env for next PM2 restart if not already set (dev convenience)
  if (!process.env.CHROME_BIN && !process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log(`[CHROME] Tip: set CHROME_BIN=${chromePath} in .env for stability`);
  }
} else {
  const msg = 'No system Chrome/Chromium found and puppeteer cache empty';
  console.warn(`[CHROME] ${msg}`);
  console.warn('[CHROME] Fix Windows: ensure Chrome at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe or set CHROME_BIN in .env');
  console.warn('[CHROME] Fix Linux/Pi: sudo apt-get install chromium-browser  OR  npx puppeteer browsers install chrome');
  lastLaunchError = msg + ' — checked candidates logged above';
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: process.env.CLIENT_ID || 'latiabetina-bot' }),
  puppeteer: {
    headless: true,
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
    ],
  },
});

// Helper to initialize without crashing the process on Chrome-not-found
function safeInitialize() {
  client.initialize().catch(err => {
    // Capture full error for /qr diagnostics
    const msg = err?.message || String(err);
    const stack = err?.stack || '';
    lastLaunchError = msg + (stack ? `\n${stack.split('\n').slice(1,4).join('\n')}` : '');
    console.error('[FATAL] Failed to launch Chrome:', msg);
    console.error(stack);
    if (msg.includes('Could not find Chrome') || msg.includes('Browser was not found') || msg.includes('executablePath')) {
      console.error('[HINT] Set CHROME_BIN or PUPPETEER_EXECUTABLE_PATH to a valid Chrome/Chromium binary.');
      console.error('[HINT] Or install Chrome for puppeteer: npx puppeteer browsers install chrome');
    } else if (msg.includes('Failed to launch') || msg.includes('ENOENT') || msg.includes('EACCES')) {
      console.error('[HINT] Chrome binary found but failed to start — check permissions, --no-sandbox, or profile lock.');
      console.error(`[HINT] Tried executable: ${chromePath || '(undefined — auto)'}`);
    }
    clientStatus = 'FAILED';
    clearLoadingWatchdog();
  });
}

// Prevent unhandled rejections (e.g. Chrome launch failure) from crashing the process
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  console.error('[UNHANDLED REJECTION]', msg);
  if (!lastLaunchError) lastLaunchError = msg;
  if (msg.includes('Could not find Chrome') || msg.includes('Browser was not found') || msg.includes('Failed to launch')) {
    clientStatus = 'FAILED';
    clearLoadingWatchdog();
  }
});
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  if (msg.includes('Could not find Chrome') || msg.includes('Browser was not found') || msg.includes('Failed to launch')) {
    console.error('[UNCAUGHT]', msg);
    if (!lastLaunchError) lastLaunchError = msg;
    clientStatus = 'FAILED';
    clearLoadingWatchdog();
    return; // don't exit
  }
  console.error('[UNCAUGHT EXCEPTION]', err);
});

client.on('loading_screen', (percent, message) => {
  console.log(`[LOADING] ${percent}% — ${message}`);
  clientStatus = 'LOADING';
  // Start watchdog every time we enter loading — resets the timer
  startLoadingWatchdog();
});

client.on('authenticated', () => {
  console.log('[AUTH] Authenticated successfully');
  clearLoadingWatchdog();
  reconnectAttempts = 0;
  clientStatus = 'AUTHENTICATED';
});

client.on('ready', () => {
  console.log('[READY] WhatsApp client is ready');
  clearLoadingWatchdog();
  reconnectAttempts = 0;
  clientStatus = 'READY';
  lastQr = null;

  // Persist the linked number so it can be retrieved even if disconnected
  try {
    const number = client.info.wid.user;
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUTH_DIR, 'last_number.txt'), number);
    console.log(`[INFO] Linked number persisted: ${number}`);
  } catch (err) {
    console.error('[ERROR] Failed to persist linked number:', err.message);
  }
});

client.on('qr', qr => {
  console.log('[QR] QR code received — scan with WhatsApp');
  clearLoadingWatchdog(); // QR arrived = not stuck
  qrcode.generate(qr, { small: true });
  lastQr = qr;
  clientStatus = 'QR_RECEIVED';
});

client.on('auth_failure', msg => {
  console.error('[AUTH_FAILURE]', msg);
  clientStatus = 'AUTH_FAILURE';
  lastQr = null;
  // Wipe bad session so next initialize shows a QR
  wipeSession();
  setTimeout(() => {
    clientStatus = 'INITIALIZING';
    startLoadingWatchdog();
    safeInitialize();
  }, 3000);
});

client.on('disconnected', (reason) => {
  console.log('[DISCONNECTED]', reason);
  clearLoadingWatchdog();
  clientStatus = 'DISCONNECTED';
  lastQr = null;

  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60_000); // exponential backoff, max 60s
  reconnectAttempts++;
  console.log(`[RECONNECT] Attempt ${reconnectAttempts} in ${delay / 1000}s...`);
  setTimeout(() => {
    clientStatus = 'INITIALIZING';
    startLoadingWatchdog();
    safeInitialize();
  }, delay);
});

// Start the initial watchdog before first initialize
startLoadingWatchdog();
safeInitialize();

const normalizePhone = phone => {
  let digits = phone.replace(/\D/g, '');
  // Mexico: if 10-digit national number without country code, prepend 52
  // Common formats: 8112345678 -> 528112345678 ; 528112345678 stays ; +52 811... -> 52811...
  if (digits.length === 10) digits = `52${digits}`;
  // If starts with 521 (old MX mobile prefix), WA expects 52 without 1: 521811... -> 52811...
  if (digits.length === 13 && digits.startsWith('521')) digits = `52${digits.slice(3)}`;
  return `${digits}@c.us`;
};

// Helper: detect LID / invalid number errors from WA Web
function isLidError(msg) {
  if (!msg) return false;
  const s = String(msg);
  return s.includes('No LID') || s.includes('LID for user') || s.includes('Evaluation failed') && s.includes('LID') || s.includes('wid error');
}
function mapSendError(err) {
  const raw = err?.message || String(err);
  if (isLidError(raw)) {
    return { status: 400, message: 'El número no está registrado en WhatsApp o es inválido (No LID). Verifique el número.' };
  }
  // getChat/undefined after send is often a post-send ack error — message was actually delivered
  // Don't map to 503 (bot not ready) here; let caller decide. Return null so raw error is logged,
  // and PHP job can treat it as warning + success if needed.
  if (raw.includes('EBUSY') || raw.includes('File in use')) {
    return { status: 409, message: 'WhatsApp está ocupado, intente nuevamente.' };
  }
  return null;
}

app.post('/api/send-message', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;
  
  if (clientStatus !== 'READY') {
    return res.status(503).json({ 
      error: `Bot is not ready (Status: ${clientStatus}). Please visit the QR page to authenticate.`,
      status: clientStatus 
    });
  }

  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  try {
    const rawNumber = normalizePhone(phone);
    // Resolve to LID/c.us if possible, but NEVER block valid numbers that exist
    // getNumberId can return null or @lid even for valid numbers due to privacy
    let number = rawNumber;
    try {
      const numberId = await client.getNumberId(rawNumber);
      if (numberId && numberId._serialized) {
        number = numberId._serialized;
        console.log(`[SEND] Resolved ${rawNumber} -> ${number}`);
      } else {
        console.warn(`[SEND] getNumberId null for ${rawNumber}, trying direct send`);
      }
    } catch (e) {
      console.warn(`[SEND] getNumberId error for ${rawNumber}: ${e?.message} — trying direct send`);
    }
    const sent = await client.sendMessage(number, message);
    // whatsapp-web.js puede retornar undefined justo después de enviar (race en serialización id)
    // si el mensaje ya se entregó (lo recibes), no lo trates como error
    if (!sent || !sent.id || !sent.id._serialized) {
      console.warn(`[SEND] sendMessage para ${number} retornó sin id pero probablemente entregado`, sent);
      return res.json({ id: null, warning: 'Enviado sin id (entregado)' });
    }
    return res.json({ id: sent.id._serialized });
  } catch (error) {
    console.error('Send message error', error);
    // Si el mensaje sí se envió pero falló el ack getChat, trátalo como éxito con warning
    if (String(error?.message || '').includes("Cannot read properties of undefined (reading 'id')")) {
      console.warn(`[SEND] id undefined pero mensaje a ${number} probablemente entregado`);
      return res.json({ id: null, warning: 'Enviado (id no disponible)' });
    }
    const mapped = mapSendError(error);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message });
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/send-image', authMiddleware, async (req, res) => {
  const { phone, message, mediaUrl, base64, mimetype, filename } = req.body;
  
  if (clientStatus !== 'READY') {
    return res.status(503).json({ 
      error: `Bot is not ready (Status: ${clientStatus}). Please visit the QR page to authenticate.`,
      status: clientStatus 
    });
  }

  if (!phone) return res.status(400).json({ error: 'phone is required' });
  if (!mediaUrl && !base64) return res.status(400).json({ error: 'mediaUrl or base64 is required' });

  try {
    const rawNumber = normalizePhone(phone);
    let number = rawNumber;
    try {
      const numberId = await client.getNumberId(rawNumber);
      if (numberId && numberId._serialized) {
        number = numberId._serialized;
        console.log(`[SEND-IMAGE] Resolved ${rawNumber} -> ${number}`);
      } else {
        console.warn(`[SEND-IMAGE] getNumberId null for ${rawNumber}, trying direct send`);
      }
    } catch (e) {
      console.warn(`[SEND-IMAGE] getNumberId error for ${rawNumber}: ${e?.message} — trying direct send`);
    }
    let media;
    
    if (mediaUrl) {
      media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
    } else {
      media = new MessageMedia(mimetype || 'image/jpeg', base64, filename || 'image.jpg');
    }

    const sent = await client.sendMessage(number, media, { caption: message || '' });
    if (!sent || !sent.id || !sent.id._serialized) {
      console.warn(`[SEND-IMAGE] sendMessage para ${number} sin id pero probablemente entregado`, sent);
      return res.json({ id: null, warning: 'Enviado sin id (entregado)' });
    }
    return res.json({ id: sent.id._serialized });
  } catch (error) {
    console.error('Send image error', error);
    if (String(error?.message || '').includes("Cannot read properties of undefined (reading 'id')")) {
      console.warn(`[SEND-IMAGE] id undefined pero mensaje a ${number} probablemente entregado`);
      return res.json({ id: null, warning: 'Enviado (id no disponible)' });
    }
    const mapped = mapSendError(error);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message });
    return res.status(500).json({ error: error.message });
  }
});

app.get('/qr', authMiddleware, async (req, res) => {
  if (clientStatus === 'READY') {
    return res.send(`
      <html>
        <head>
          <title>WhatsApp Ready</title>
          <style>
            body { background: #0f172a; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: rgba(255,255,255,0.05); padding: 2rem; border-radius: 1rem; text-align: center; border: 1px solid #22c55e; }
            h1 { color: #22c55e; }
            button { margin-top: 1rem; padding: 0.5rem 1rem; border-radius: 0.5rem; border: none; background: #ef4444; color: white; cursor: pointer; transition: opacity 0.2s; }
            button:hover { opacity: 0.8; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>✅ WhatsApp is Ready</h1>
            <p>The bot is already authenticated and active.</p>
            <button onclick="location.href='/logout?pw=' + new URLSearchParams(window.location.search).get('pw')">Logout / Reset</button>
          </div>
        </body>
      </html>
    `);
  }

  if (clientStatus === 'FAILED') {
    const safeErr = (lastLaunchError || 'Unknown launch error — check server logs').replace(/</g,'&lt;');
    const tried = (chromePath || 'auto (undefined)').replace(/</g,'&lt;');
    return res.send(`
      <html>
        <head><title>Chrome Error</title>
          <style>
            body { background: #0f172a; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: rgba(239,68,68,0.1); padding: 2rem; border-radius: 1rem; text-align: center; border: 1px solid #ef4444; max-width: 700px; }
            h1 { color: #ef4444; } code { background: rgba(0,0,0,0.3); padding: 0.2rem 0.4rem; border-radius: 0.3rem; font-size: 0.85rem; word-break: break-all; }
            pre { background: rgba(0,0,0,0.4); padding: 1rem; border-radius: 0.5rem; text-align: left; overflow: auto; font-size: 0.8rem; color: #f87171; white-space: pre-wrap; }
            p { color: #94a3b8; text-align: left; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>❌ Chrome Launch Failed</h1>
            <p><strong>Tried executable:</strong> <code>${tried}</code></p>
            <pre>${safeErr}</pre>
            <p><strong>Fix (Windows dev):</strong> Ensure Chrome is at <code>C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe</code> or set <code>CHROME_BIN</code> in .env to the full path.</p>
            <p><strong>Fix (Linux/Raspberry Pi):</strong> <code>sudo apt-get update && sudo apt-get install -y chromium-browser</code> then set <code>CHROME_BIN=/usr/bin/chromium-browser</code> in .env, or run <code>npx puppeteer browsers install chrome</code> (requires network).</p>
            <p><strong>Logs:</strong> Check <code>pm2 logs WhatsappBot</code> or <code>server_output.log</code> for full stack. Try <a href="/reset?pw=${req.query.pw}" style="color:#38bdf8">Reset</a> after fixing.</p>
            <p><strong>Debug:</strong> <a href="/status?pw=${req.query.pw}" style="color:#38bdf8">/status</a> shows JSON with lastError.</p>
          </div>
        </body>
      </html>
    `);
  }

  if (!lastQr) {
    return res.send(`
      <html>
        <head>
          <title>Initializing...</title>
          <style>
            body { background: #0f172a; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .spinner { border: 4px solid rgba(255,255,255,0.1); border-left-color: #38bdf8; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin-bottom: 1rem; }
            @keyframes spin { to { transform: rotate(360deg); } }
            .status { font-weight: bold; color: #38bdf8; }
          </style>
        </head>
        <body>
          <div class="spinner"></div>
          <h1>Status: <span class="status">${clientStatus}</span></h1>
          <p style="color: #94a3b8;">Waiting for WhatsApp to initialize or provide a QR code...</p>
          <script>setTimeout(() => location.reload(), 2000)</script>
        </body>
      </html>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(lastQr);
    res.send(`
      <html>
        <head>
          <title>WhatsApp QR Code</title>
          <style>
            body { 
              background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); 
              color: white; 
              font-family: 'Inter', sans-serif; 
              display: flex; 
              flex-direction: column; 
              align-items: center; 
              justify-content: center; 
              height: 100vh; 
              margin: 0; 
            }
            .container {
              background: rgba(255, 255, 255, 0.05);
              backdrop-filter: blur(10px);
              padding: 3rem;
              border-radius: 2rem;
              box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
              border: 1px solid rgba(255, 255, 255, 0.1);
              text-align: center;
              animation: fadeIn 0.5s ease-out;
            }
            @keyframes fadeIn {
              from { opacity: 0; transform: translateY(20px); }
              to { opacity: 1; transform: translateY(0); }
            }
            img { 
              border: 12px solid white; 
              border-radius: 1rem; 
              margin: 2rem 0; 
              box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
            }
            h1 { margin: 0; color: #38bdf8; font-size: 2rem; }
            p { color: #94a3b8; margin-top: 1rem; }
            .status { margin-top: 2rem; font-size: 0.875rem; color: #22c55e; display: flex; align-items: center; gap: 0.5rem; justify-content: center; }
            .status-dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; animation: pulse 2s infinite; }
            @keyframes pulse {
              0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
              70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
              100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Scan WhatsApp Bot</h1>
            <p>Open WhatsApp on your phone > Settings > Linked Devices > Link a Device</p>
            <img src="${qrImage}" alt="QR Code" />
            <div class="status">
              <div class="status-dot"></div>
              Waiting for scan...
            </div>
          </div>
          <script>
            setTimeout(() => location.reload(), 30000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generating QR code');
  }
});

app.get('/logout', authMiddleware, async (req, res) => {
  try {
    await client.logout();
    clientStatus = 'DISCONNECTED';
    lastQr = null;
    // Wipe saved session so next restart shows a fresh QR
    wipeSession();
    res.send(`Logged out. <a href="/qr?pw=${req.query.pw}">Go back to QR</a>`);
    setTimeout(() => {
      clientStatus = 'INITIALIZING';
      startLoadingWatchdog();
      safeInitialize();
    }, 1000);
  } catch (err) {
    res.status(500).send('Logout failed: ' + err.message);
  }
});

// Manual recovery endpoint — wipes session + reinitializes for a fresh QR
app.get('/reset', authMiddleware, async (req, res) => {
  console.log('[RESET] Manual reset triggered via /reset endpoint');
  clearLoadingWatchdog();
  lastQr = null;
  clientStatus = 'RESTARTING';
  reconnectAttempts = 0;
  try { await client.destroy(); } catch (_) {}
  wipeSession();
  setTimeout(() => {
    clientStatus = 'INITIALIZING';
    startLoadingWatchdog();
    safeInitialize();
  }, 2000);
  res.send(`
    <html>
      <head>
        <title>Resetting...</title>
        <meta http-equiv="refresh" content="5;url=/qr?pw=${req.query.pw}">
        <style>
          body { background: #0f172a; color: white; font-family: sans-serif;
                 display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: rgba(255,255,255,0.05); padding: 2rem; border-radius: 1rem;
                  text-align: center; border: 1px solid #f59e0b; max-width: 400px; }
          h1 { color: #f59e0b; }
          p { color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🔄 Resetting Session</h1>
          <p>Session wiped. Redirecting to QR page in 5 seconds...</p>
          <p><a href="/qr?pw=${req.query.pw}" style="color:#38bdf8">Click here if not redirected</a></p>
        </div>
      </body>
    </html>
  `);
});

app.get('/status', authMiddleware, (req, res) => {
  console.log(`[${new Date().toISOString()}] Status check from ${req.ip}`);
  res.json({ status: clientStatus, hasQr: !!lastQr, chromePath: chromePath || null, lastError: lastLaunchError || null, platform: process.platform });
});

app.get('/me', authMiddleware, (req, res) => {
  // If fully ready, return live info
  if (clientStatus === 'READY' && client.info) {
    return res.json({ 
      number: client.info.wid.user, 
      name: client.info.pushname,
      status: clientStatus 
    });
  }

  // Fallback: Try to read last known number from persisted file
  const lastNumberPath = path.join(AUTH_DIR, 'last_number.txt');
  if (fs.existsSync(lastNumberPath)) {
    try {
      const number = fs.readFileSync(lastNumberPath, 'utf8');
      return res.json({ 
        number: number, 
        name: 'Previously Linked Account', 
        status: clientStatus,
        is_fallback: true
      });
    } catch (err) {
      // Ignore read errors
    }
  }

  return res.status(503).json({ 
    error: 'Client not ready and no stored session available', 
    status: clientStatus 
  });
});

const PORT = process.env.PORT || 3007;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`WhatsApp bot listening on http://${HOST}:${PORT}`);
});