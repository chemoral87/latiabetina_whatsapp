import dotenv from 'dotenv';
dotenv.config({ path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env' });
import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const { Client, LocalAuth, MessageMedia } = pkg;

// ─── Config ────────────────────────────────────────────────────────────────
const CLIENT_ID       = process.env.CLIENT_ID || 'latiabetina-bot';
const AUTH_DIR        = path.resolve('.wwebjs_auth');
const CACHE_DIR       = path.resolve('.wwebjs_cache');

// How long (ms) to wait in LOADING before declaring it stuck and auto-resetting
const LOADING_TIMEOUT_MS = 60_000; // 1 minute
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
      try { client.destroy(); } catch (_) {}
      setTimeout(() => client.initialize(), 2000);
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

const client = new Client({
  authStrategy: new LocalAuth({ clientId: process.env.CLIENT_ID || 'latiabetina-bot' }),
  puppeteer: { 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
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
    client.initialize();
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
    client.initialize();
  }, delay);
});

// Start the initial watchdog before first initialize
startLoadingWatchdog();
client.initialize();

const normalizePhone = phone => {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
};

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
    const number = normalizePhone(phone);
    const sent = await client.sendMessage(number, message);
    return res.json({ id: sent.id._serialized });
  } catch (error) {
    console.error('Send message error', error);
    let message = error.message;
    if (message.includes('getChat') || message.includes('undefined')) {
      message = "WhatsApp Bot session is not active. Please scan the QR code to authenticate.";
    }
    return res.status(500).json({ error: message });
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
    const number = normalizePhone(phone);
    let media;
    
    if (mediaUrl) {
      media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
    } else {
      media = new MessageMedia(mimetype || 'image/jpeg', base64, filename || 'image.jpg');
    }

    const sent = await client.sendMessage(number, media, { caption: message || '' });
    return res.json({ id: sent.id._serialized });
  } catch (error) {
    console.error('Send image error', error);
    let errorMsg = error.message;
    if (errorMsg && (errorMsg.includes('getChat') || errorMsg.includes('undefined'))) {
      errorMsg = "WhatsApp Bot session is not active. Please scan the QR code to authenticate.";
    }
    return res.status(500).json({ error: errorMsg });
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
    res.send(`Logged out. <a href="/qr?pw=${req.query.pw}">Go back to QR</a>`);
    setTimeout(() => {
      clientStatus = 'INITIALIZING';
      startLoadingWatchdog();
      client.initialize();
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
    client.initialize();
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
  res.json({ status: clientStatus, hasQr: !!lastQr });
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