require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = parseInt(process.env.PORT) || 3000;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 30000;
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET_KEY;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_WS_CONNECTIONS = parseInt(process.env.MAX_WS_CONNECTIONS) || 500;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

if (TRUST_PROXY) app.set('trust proxy', 1);

//  Security Headers 
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://www.google.com", "https://www.gstatic.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["https://www.google.com", "https://recaptcha.google.com", "https://www.recaptcha.net"],
      connectSrc: ["'self'", "wss:", "ws:", "https://www.google.com", "https://www.recaptcha.net"],
      imgSrc: ["'self'", "data:", "https://www.google.com", "https://www.gstatic.com"],
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));

//  Compression 
app.use(compression());

//  Body Parsing 
app.use(express.json({ limit: '10kb' }));

//  CORS
app.use(cors(NODE_ENV === 'production'
  ? { origin: process.env.ALLOWED_ORIGIN || false }
  : {}
));

//  Rate Limiting 
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later.' }
});

const captchaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts.' }
});

app.use('/api/', apiLimiter);
app.use('/api/verify-captcha', captchaLimiter);

//  Static Files 
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
}));

//  Data Fetching 
const ROBLOX_API = 'https://games.roblox.com/v1/games/11765852158/servers/Public?limit=100';
const RBWR_API = 'https://hydrogen.realisticbwr.org/api/public/servers';

let latestData = null;
let lastFetchTime = 0;
let fetchCount = 0;

function buildCombinedData(robloxResult, rbwrResult) {
  const robloxData = robloxResult.status === 'fulfilled' ? robloxResult.value : null;
  const rbwrData = rbwrResult.status === 'fulfilled' ? rbwrResult.value : null;

    const rbwrServers = (rbwrData && rbwrData.success && rbwrData.data && rbwrData.data.servers) || [];
    const robloxServers = (robloxData && robloxData.data) || [];

    log('info', `Raw: Roblox servers=${robloxServers.length}, RBWR servers=${rbwrServers.length}`);

  const rbwrMap = {};
  rbwrServers.forEach(s => { if (s.jobId) rbwrMap[s.jobId] = s; });

  const combinedServers = robloxServers.map(rs => {
    const rb = rbwrMap[rs.id] || null;
    return {
      id: rs.id,
      maxPlayers: rs.maxPlayers,
      playing: rs.playing,
      fps: rs.fps,
      ping: rs.ping,
      players: rs.players || [],
      rbwr: rb ? { id: rb.id, jobId: rb.jobId, lastHeartbeat: rb.lastHeartbeat, state: rb.state || {} } : null
    };
  });

  const rbwrOnly = rbwrServers
    .filter(rb => !robloxServers.some(r => r.id === rb.jobId))
    .map(rb => ({
      id: rb.jobId || rb.id, maxPlayers: 0, playing: 0, fps: 0, ping: 0, players: [],
      rbwr: { id: rb.id, jobId: rb.jobId, lastHeartbeat: rb.lastHeartbeat, state: rb.state || {} }
    }));

  return {
    servers: [...combinedServers, ...rbwrOnly],
    stats: (rbwrData && rbwrData.data && rbwrData.data.stats) || null,
    meta: {
      robloxApiAvailable: robloxResult.status === 'fulfilled',
      rbwrApiAvailable: rbwrResult.status === 'fulfilled',
      lastUpdated: new Date().toISOString(),
      totalServers: combinedServers.length + rbwrOnly.length,
    }
  };
}

async function fetchAndBroadcast() {
  try {
    const [robloxResult, rbwrResult] = await Promise.allSettled([
      fetch(ROBLOX_API, { headers: { Accept: 'application/json' }, timeout: 10000 }).then(r => r.json()),
      fetch(RBWR_API, { headers: { Accept: 'application/json' }, timeout: 10000 }).then(r => r.json())
    ]);

    latestData = buildCombinedData(robloxResult, rbwrResult);
    lastFetchTime = Date.now();
    fetchCount++;

    if (robloxResult.status === 'rejected') log('warn', `Roblox API error: ${robloxResult.reason.message}`);
    if (rbwrResult.status === 'rejected') log('warn', `RBWR API error: ${rbwrResult.reason.message}`);

    const message = JSON.stringify({ type: 'update', data: latestData });
    let sent = 0;
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        sent++;
      }
    });

    log('info', `Poll #${fetchCount}: ${latestData.meta.totalServers} servers, ${sent} clients updated`);
  } catch (error) {
    log('error', `Poll failed: ${error.message}`);
  }
}

//  WebSocket 
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 1024 });

const wsConnections = new Map();

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Attach this before anything else. A socket 'error' with no listener is
  // thrown, which reaches the uncaughtException handler below and takes the
  // whole server down; a single oversized frame from one client did exactly
  // that. The socket is already closed by the time we get here.
  ws.on('error', (err) => {
    const conn = wsConnections.get(ws);
    log('warn', `WS error [${conn ? conn.id : '?'}] from ${ip}: ${err.message}`);
    // The map entry is left for the 'close' handler, which always follows an
    // 'error' event and logs the connection id properly.
    try { ws.terminate(); } catch (e) {}
  });

  if (wss.clients.size > MAX_WS_CONNECTIONS) {
    log('warn', `Connection rejected: max ${MAX_WS_CONNECTIONS} reached`);
    ws.close(1013, 'Server full');
    return;
  }

  const connId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  wsConnections.set(ws, { id: connId, ip, connectedAt: Date.now() });

  log('info', `WS+ [${connId}] from ${ip} (${wss.clients.size} total)`);

  if (latestData) {
    ws.send(JSON.stringify({ type: 'update', data: latestData }));
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Push-only channel: the server never asks a client for anything. Control
  // frames (ping/pong/close) are handled inside ws and never reach this
  // handler, so anything arriving here is data we refuse to accept. Closing
  // rather than ignoring keeps the socket from being treated as a request API.
  ws.on('message', () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    log('warn', `WS client [${connId}] sent data; closing send-only channel`);
    ws.close(1003, 'Send-only channel');
  });

  ws.on('close', () => {
    const conn = wsConnections.get(ws);
    wsConnections.delete(ws);
    log('info', `WS- [${conn ? conn.id : '?'}] (${wss.clients.size} total)`);
  });
});

// Heartbeat to detect dead connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// Server-level failures (handshake, listen) need a listener too.
wss.on('error', (err) => {
  log('error', `WebSocket server error: ${err.message}`);
});

// And the HTTP server itself, e.g. EADDRINUSE. Without this it lands in
// uncaughtException with a misleading "shutting down" message.
server.on('error', (err) => {
  log('error', `HTTP server error: ${err.message}`);
  gracefulShutdown('server error');
});

//  Config Endpoint
app.get('/api/config', (req, res) => {
  res.json({
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
    env: NODE_ENV,
  });
});

//  REST Endpoints 
app.get('/api/servers', (req, res) => {
  if (latestData) return res.json(latestData);
  res.json({ servers: [], stats: null, meta: { robloxApiAvailable: false, rbwrApiAvailable: false, lastUpdated: null, totalServers: 0 } });
});

app.get('/api/servers/:id', (req, res) => {
  if (!latestData) return res.status(503).json({ error: 'Data not yet available' });
  const srv = latestData.servers.find(s => s.id === req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  res.json({ server: srv, stats: latestData.stats, meta: latestData.meta });
});

app.post('/api/verify-captcha', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'No token provided' });
  if (!RECAPTCHA_SECRET) {
    log('warn', 'reCAPTCHA secret not configured — skipping verification');
    return res.json({ success: true, skipped: true });
  }

  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(RECAPTCHA_SECRET)}&response=${encodeURIComponent(token)}&remoteip=${req.ip}`,
      timeout: 5000,
    });
    const data = await response.json();
    log('info', `reCAPTCHA verify: success=${data.success} score=${data.score || 'N/A'} ip=${req.ip}`);
    res.json({ success: data.success === true, score: data.score });
  } catch (error) {
    log('error', `reCAPTCHA verify failed: ${error.message}`);
    res.status(500).json({ success: false, error: 'Verification service unavailable' });
  }
});

//  Health Check 
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    fetchCount,
    lastFetchTime: lastFetchTime ? new Date(lastFetchTime).toISOString() : null,
    wsClients: wss.clients.size,
    memory: process.memoryUsage(),
  };
  res.json(health);
});

//  SPA Fallback 
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

//  Logging 
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

//  Gud Shutdown 
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('info', `${signal} received, shutting down...`); // Added because my FUCKING SERVER cant shutdown normally

  // Stop accepting new connections
  server.close(() => {
    log('info', 'HTTP server closed');
  });

  // Close all WebSocket connections
  wss.clients.forEach(ws => {
    ws.close(1001, 'Server shutting down');
  });

  clearInterval(heartbeatInterval);

  // Force close after 5s
  setTimeout(() => {
    log('warn', 'Forcing shutdown');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception: ${err.message}`);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

//  Start 
setInterval(fetchAndBroadcast, POLL_INTERVAL);

server.listen(PORT, () => {
  log('info', `ReBWR running on http://localhost:${PORT} [${NODE_ENV}]`);
  log('info', `WebSocket ready | Polling every ${POLL_INTERVAL / 1000}s | Max WS: ${MAX_WS_CONNECTIONS}`);
  fetchAndBroadcast();
});
