'use strict';

const express = require('express');
const webpush = require('web-push');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (ADMIN_PIN === '1234') {
  console.warn('[警告] 正在使用預設攤主密碼 1234，請設定環境變數 ADMIN_PIN。');
}

// ---------- Web Push (VAPID) ----------
function loadVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (fs.existsSync(VAPID_FILE)) return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.log('已產生新的 VAPID 金鑰：', VAPID_FILE);
  return keys;
}
const vapid = loadVapidKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

// ---------- State ----------
const defaultState = () => ({
  boothName: process.env.BOOTH_NAME || '攤位叫號',
  nextNumber: 1,
  nowServing: null, // number most recently called
  notifyAhead: 3, // "等待人數剩 3 組" reminder
  avgMinutes: 3, // estimated minutes per group
  paused: false, // stop handing out new tickets
  tickets: [],
});

let state = defaultState();
try {
  if (fs.existsSync(STATE_FILE)) state = { ...defaultState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
} catch (err) {
  console.error('讀取狀態檔失敗，使用空白狀態：', err.message);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }, 100);
}

const waitingTickets = () =>
  state.tickets.filter((t) => t.status === 'waiting').sort((a, b) => a.number - b.number);
const findTicket = (id) => state.tickets.find((t) => t.id === id);
const aheadOf = (ticket) => waitingTickets().filter((t) => t.number < ticket.number).length;

function publicTicket(t) {
  const ahead = t.status === 'waiting' ? aheadOf(t) : 0;
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    ahead,
    estimatedMinutes: ahead * state.avgMinutes,
    createdAt: t.createdAt,
    calledAt: t.calledAt || null,
    hasPush: Boolean(t.pushSub),
    nowServing: state.nowServing,
    notifyAhead: state.notifyAhead,
    boothName: state.boothName,
  };
}

function adminState() {
  return {
    boothName: state.boothName,
    nextNumber: state.nextNumber,
    nowServing: state.nowServing,
    notifyAhead: state.notifyAhead,
    avgMinutes: state.avgMinutes,
    paused: state.paused,
    tickets: state.tickets
      .filter((t) => t.status !== 'done')
      .sort((a, b) => a.number - b.number)
      .map((t) => ({ ...publicTicket(t), pushSub: undefined })),
    doneCount: state.tickets.filter((t) => t.status === 'done').length,
  };
}

// ---------- Push ----------
async function sendPush(ticket, payload) {
  if (!ticket.pushSub) return false;
  try {
    await webpush.sendNotification(ticket.pushSub, JSON.stringify(payload), { TTL: 600, urgency: 'high' });
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      ticket.pushSub = null; // subscription expired
      save();
    } else {
      console.error(`推播失敗 #${ticket.number}:`, err.statusCode || err.message);
    }
    return false;
  }
}

function notifyCalled(ticket) {
  return sendPush(ticket, {
    title: `輪到你了！${ticket.number} 號`,
    body: `請回到「${state.boothName}」並出示此頁面號碼`,
    tag: `called-${ticket.id}`,
    url: `/?t=${ticket.id}`,
    requireInteraction: true,
  });
}

// Remind guests whose remaining groups ahead <= notifyAhead (rule 3).
function checkNearReminders() {
  waitingTickets().forEach((t, idx) => {
    if (!t.notifiedNear && idx <= state.notifyAhead) {
      t.notifiedNear = true;
      sendPush(t, {
        title: `快輪到你了（${t.number} 號）`,
        body: idx === 0 ? '下一位就是你，請立即返回現場排隊！' : `前面還有 ${idx} 組，請返回現場排隊。`,
        tag: `near-${t.id}`,
        url: `/?t=${t.id}`,
      });
    }
  });
  save();
}

// ---------- Live updates (Server-Sent Events) ----------
const sseClients = new Set();
function broadcast() {
  for (const res of sseClients) res.write(`data: ${Date.now()}\n\n`);
}
function changed() {
  checkNearReminders();
  save();
  broadcast();
}

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function publicBaseUrl(req) {
  return BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Per-ticket manifest so "加入主畫面" (iOS) opens straight to this guest's ticket
app.get('/manifest.webmanifest', (req, res) => {
  const t = typeof req.query.t === 'string' ? req.query.t.replace(/[^\w-]/g, '') : '';
  res.type('application/manifest+json').json({
    name: state.boothName,
    short_name: '叫號',
    start_url: t ? `/?t=${t}` : '/',
    scope: '/',
    display: 'standalone',
    background_color: '#fdf1e6',
    theme_color: '#ee6f57',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    vapidPublicKey: vapid.publicKey,
    boothName: state.boothName,
    paused: state.paused,
    nowServing: state.nowServing,
    waiting: waitingTickets().length,
    avgMinutes: state.avgMinutes,
    notifyAhead: state.notifyAhead,
  });
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// Guest takes a ticket
app.post('/api/tickets', (req, res) => {
  // Re-use existing active ticket on the same device (avoid duplicates on reload)
  const existing = req.body && req.body.existingId && findTicket(req.body.existingId);
  if (existing && (existing.status === 'waiting' || existing.status === 'called' || existing.status === 'skipped')) {
    return res.json(publicTicket(existing));
  }
  if (state.paused) return res.status(403).json({ error: '目前暫停取號，請洽現場工作人員。' });

  const ticket = {
    id: crypto.randomBytes(12).toString('base64url'),
    number: state.nextNumber++,
    status: 'waiting',
    createdAt: Date.now(),
    pushSub: null,
    notifiedNear: false,
  };
  state.tickets.push(ticket);
  // A new ticket that is already within the reminder range shouldn't get an immediate "near" push.
  if (aheadOf(ticket) <= state.notifyAhead) ticket.notifiedNear = true;
  changed();
  res.status(201).json(publicTicket(ticket));
});

app.get('/api/tickets/:id', (req, res) => {
  const t = findTicket(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張號碼牌' });
  res.json(publicTicket(t));
});

app.post('/api/tickets/:id/subscribe', (req, res) => {
  const t = findTicket(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張號碼牌' });
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return res.status(400).json({ error: '訂閱資料格式錯誤' });
  t.pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
  save();
  res.json({ ok: true });
});

app.post('/api/tickets/:id/test-push', async (req, res) => {
  const t = findTicket(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張號碼牌' });
  const ok = await sendPush(t, { title: '通知測試成功 ✅', body: `叫到 ${t.number} 號時會像這樣通知你`, tag: `test-${t.id}` });
  res.json({ ok });
});

// Guest cancels own ticket
app.post('/api/tickets/:id/cancel', (req, res) => {
  const t = findTicket(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張號碼牌' });
  t.status = 'done';
  t.cancelled = true;
  changed();
  res.json(publicTicket(t));
});

// QR code pointing at the guest page
app.get('/api/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(`${publicBaseUrl(req)}/`, { type: 'svg', margin: 1, width: 512 });
  res.type('image/svg+xml').send(svg);
});

// ---------- Admin ----------
function requireAdmin(req, res, next) {
  const pin = req.get('x-admin-pin') || '';
  const a = Buffer.from(pin);
  const b = Buffer.from(ADMIN_PIN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: '密碼錯誤' });
  next();
}
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/state', (req, res) => res.json({ ...adminState(), guestUrl: `${publicBaseUrl(req)}/` }));

admin.post('/call-next', async (req, res) => {
  const next = waitingTickets()[0];
  if (!next) return res.status(409).json({ error: '目前沒有等待中的來賓' });
  // Previously "called" guests who never showed up are left as called; owner can mark done/skip.
  next.status = 'called';
  next.calledAt = Date.now();
  state.nowServing = next.number;
  changed();
  const pushed = await notifyCalled(next);
  res.json({ ticket: publicTicket(next), pushed });
});

admin.post('/tickets/:id/:action', async (req, res) => {
  const t = findTicket(req.params.id);
  if (!t) return res.status(404).json({ error: '找不到這張號碼牌' });
  let pushed;
  switch (req.params.action) {
    case 'call': // call a specific ticket / recall
      t.status = 'called';
      t.calledAt = Date.now();
      state.nowServing = t.number;
      pushed = await notifyCalled(t);
      break;
    case 'done':
      t.status = 'done';
      break;
    case 'skip': // 過號
      t.status = 'skipped';
      sendPush(t, {
        title: `${t.number} 號已過號`,
        body: '請直接回到現場，找小幫手安排。',
        tag: `skip-${t.id}`,
        url: `/?t=${t.id}`,
      });
      break;
    case 'requeue': // put back into the waiting line (keeps original number / priority)
      t.status = 'waiting';
      t.notifiedNear = true; // guest is already on site

      break;
    default:
      return res.status(400).json({ error: '未知的操作' });
  }
  changed();
  res.json({ ticket: publicTicket(t), pushed });
});

admin.post('/settings', (req, res) => {
  const { boothName, notifyAhead, avgMinutes, paused } = req.body || {};
  if (typeof boothName === 'string' && boothName.trim()) state.boothName = boothName.trim().slice(0, 40);
  if (Number.isInteger(notifyAhead) && notifyAhead >= 0 && notifyAhead <= 50) state.notifyAhead = notifyAhead;
  if (typeof avgMinutes === 'number' && avgMinutes >= 0 && avgMinutes <= 120) state.avgMinutes = avgMinutes;
  if (typeof paused === 'boolean') state.paused = paused;
  changed();
  res.json(adminState());
});

admin.post('/reset', (req, res) => {
  const keep = { boothName: state.boothName, notifyAhead: state.notifyAhead, avgMinutes: state.avgMinutes };
  state = { ...defaultState(), ...keep };
  changed();
  res.json(adminState());
});

app.use('/api/admin', admin);

app.listen(PORT, () => {
  console.log(`叫號系統已啟動：http://localhost:${PORT}`);
  console.log(`  來賓頁面：/       攤主頁面：/admin       QR 海報：/poster`);
});
