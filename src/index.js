import { DurableObject } from 'cloudflare:workers';
import { generateVapidKeys, sendWebPush, b64urlEncode } from './webpush.js';

/*
 * Single Durable Object instance holds the whole queue. It is strongly
 * consistent (no duplicate numbers), never "sleeps away" its data, and
 * pushes live updates over hibernatable WebSockets (cheap on the free plan).
 */

const DEFAULT_META = {
  boothName: '攤位叫號',
  nextNumber: 1,
  nowServing: null,
  notifyAhead: 3,
  avgMinutes: 3,
  paused: false,
  doneCount: 0,
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const err = (message, status) => json({ error: message }, status);

const randomId = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));

async function sha256(text) {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class QueueDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.failedLogins = { count: 0, until: 0 };
    ctx.blockConcurrencyWhile(async () => {
      this.meta = { ...DEFAULT_META, ...((await ctx.storage.get('meta')) || {}) };
      if (env.BOOTH_NAME && !(await ctx.storage.get('meta'))) this.meta.boothName = env.BOOTH_NAME;
      this.tickets = new Map();
      const stored = await ctx.storage.list({ prefix: 't:' });
      for (const t of stored.values()) this.tickets.set(t.id, t);
      this.auth = (await ctx.storage.get('auth')) || null; // { salt, hash }
      this.vapid = await this.loadVapid();
    });
  }

  async loadVapid() {
    const subject = this.env.VAPID_SUBJECT || 'mailto:queue@example.com';
    let v = await this.ctx.storage.get('vapid');
    if (!v) {
      v = await generateVapidKeys(); // auto-generated once, kept forever
      await this.ctx.storage.put('vapid', v);
    }
    return { ...v, subject };
  }

  // ---------- helpers ----------
  waiting() {
    return [...this.tickets.values()].filter((t) => t.status === 'waiting').sort((a, b) => a.number - b.number);
  }
  aheadOf(t) {
    return this.waiting().filter((w) => w.number < t.number).length;
  }
  saveMeta() {
    return this.ctx.storage.put('meta', this.meta);
  }
  saveTicket(t) {
    return this.ctx.storage.put('t:' + t.id, t);
  }

  publicTicket(t) {
    const ahead = t.status === 'waiting' ? this.aheadOf(t) : 0;
    return {
      id: t.id,
      number: t.number,
      status: t.status,
      ahead,
      estimatedMinutes: ahead * this.meta.avgMinutes,
      createdAt: t.createdAt,
      calledAt: t.calledAt || null,
      hasPush: Boolean(t.pushSub),
      nowServing: this.meta.nowServing,
      notifyAhead: this.meta.notifyAhead,
      boothName: this.meta.boothName,
    };
  }
  publicConfig() {
    return {
      vapidPublicKey: this.vapid.publicKey,
      boothName: this.meta.boothName,
      paused: this.meta.paused,
      nowServing: this.meta.nowServing,
      waiting: this.waiting().length,
      avgMinutes: this.meta.avgMinutes,
      notifyAhead: this.meta.notifyAhead,
    };
  }
  adminState() {
    const { boothName, nextNumber, nowServing, notifyAhead, avgMinutes, paused, doneCount } = this.meta;
    return {
      boothName, nextNumber, nowServing, notifyAhead, avgMinutes, paused, doneCount,
      tickets: [...this.tickets.values()].filter((t) => t.status !== 'done').sort((a, b) => a.number - b.number).map((t) => this.publicTicket(t)),
    };
  }

  // ---------- push ----------
  async push(t, payload) {
    if (!t.pushSub) return false;
    try {
      const r = await sendWebPush(t.pushSub, payload, this.vapid);
      if (r.gone) {
        t.pushSub = null;
        await this.saveTicket(t);
      } else if (!r.ok) console.log(`push failed #${t.number}: ${r.status}`);
      return r.ok;
    } catch (e) {
      console.log(`push error #${t.number}: ${e.message}`);
      return false;
    }
  }
  notifyCalled(t) {
    return this.push(t, {
      title: `輪到你了！${t.number} 號`,
      body: `請回到「${this.meta.boothName}」並出示此頁面號碼`,
      tag: `called-${t.id}`,
      url: `/?t=${t.id}`,
      requireInteraction: true,
    });
  }
  nearReminders() {
    const jobs = [];
    this.waiting().forEach((t, idx) => {
      if (!t.notifiedNear && idx <= this.meta.notifyAhead) {
        t.notifiedNear = true;
        jobs.push(this.saveTicket(t));
        jobs.push(this.push(t, {
          title: `快輪到你了（${t.number} 號）`,
          body: idx === 0 ? '下一位就是你，請立即返回現場排隊！' : `前面還有 ${idx} 組，請返回現場排隊。`,
          tag: `near-${t.id}`,
          url: `/?t=${t.id}`,
        }));
      }
    });
    return jobs;
  }

  /** Persist + broadcast + reminders after any change. */
  async changed(extraJobs = []) {
    const jobs = [this.saveMeta(), ...this.nearReminders(), ...extraJobs];
    this.broadcast();
    await Promise.allSettled(jobs);
  }

  broadcast() {
    const config = JSON.stringify({ type: 'config', data: this.publicConfig() });
    let admin = null;
    for (const ws of this.ctx.getWebSockets()) {
      const [tag] = this.ctx.getTags(ws);
      try {
        if (tag === 'admin') ws.send((admin ??= JSON.stringify({ type: 'admin', data: this.adminState() })));
        else if (tag && tag.startsWith('t:')) {
          const t = this.tickets.get(tag.slice(2));
          ws.send(t ? JSON.stringify({ type: 'ticket', data: this.publicTicket(t) }) : JSON.stringify({ type: 'gone' }));
        } else ws.send(config);
      } catch (e) { /* socket closing */ }
    }
  }

  // ---------- auth ----------
  async checkPin(pin) {
    const now = Date.now();
    if (now < this.failedLogins.until) return 'locked';
    let ok = false;
    if (this.env.ADMIN_PIN) ok = safeEqual(pin || '', this.env.ADMIN_PIN);
    else if (this.auth) ok = safeEqual(await sha256(this.auth.salt + (pin || '')), this.auth.hash);
    if (ok) {
      this.failedLogins = { count: 0, until: 0 };
      return 'ok';
    }
    if (++this.failedLogins.count >= 5) this.failedLogins = { count: 0, until: now + 60_000 };
    return 'bad';
  }
  async setPin(pin) {
    const salt = randomId();
    this.auth = { salt, hash: await sha256(salt + pin) };
    await this.ctx.storage.put('auth', this.auth);
  }
  pinConfigured() {
    return Boolean(this.env.ADMIN_PIN || this.auth);
  }

  // ---------- WebSocket (hibernation API) ----------
  async webSocketMessage(ws, msg) {
    if (msg === 'ping') ws.send('pong');
  }
  async webSocketClose(ws, code) {
    try { ws.close(code, 'bye'); } catch (e) {}
  }

  // ---------- HTTP ----------
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};

    // live updates
    if (path === '/api/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return err('需要 WebSocket', 426);
      let tag = 'public';
      let first;
      if (url.searchParams.get('role') === 'admin') {
        const r = await this.checkPin(url.searchParams.get('pin'));
        if (r !== 'ok') return err('密碼錯誤', 401);
        tag = 'admin';
        first = { type: 'admin', data: this.adminState() };
      } else if (url.searchParams.get('t')) {
        const t = this.tickets.get(url.searchParams.get('t'));
        if (!t) return err('找不到這張號碼牌', 404);
        tag = 't:' + t.id;
        first = { type: 'ticket', data: this.publicTicket(t) };
      } else first = { type: 'config', data: this.publicConfig() };
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [tag]);
      pair[1].send(JSON.stringify(first));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === '/manifest.webmanifest') {
      const t = (url.searchParams.get('t') || '').replace(/[^\w-]/g, '');
      return new Response(JSON.stringify({
        name: this.meta.boothName,
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
      }), { headers: { 'Content-Type': 'application/manifest+json' } });
    }

    if (path === '/api/config' && method === 'GET') return json(this.publicConfig());

    // ----- guest -----
    if (path === '/api/tickets' && method === 'POST') {
      const existing = body.existingId && this.tickets.get(body.existingId);
      if (existing && existing.status !== 'done') return json(this.publicTicket(existing));
      if (this.meta.paused) return err('目前暫停取號，請洽現場工作人員。', 403);
      const t = { id: randomId(), number: this.meta.nextNumber++, status: 'waiting', createdAt: Date.now(), pushSub: null, notifiedNear: false };
      this.tickets.set(t.id, t);
      if (this.aheadOf(t) <= this.meta.notifyAhead) t.notifiedNear = true; // already close: no "near" push
      await this.changed([this.saveTicket(t)]);
      return json(this.publicTicket(t), 201);
    }

    let m = path.match(/^\/api\/tickets\/([\w-]+)(?:\/(subscribe|test-push|cancel))?$/);
    if (m) {
      const t = this.tickets.get(m[1]);
      if (!t) return err('找不到這張號碼牌', 404);
      const action = m[2];
      if (!action && method === 'GET') return json(this.publicTicket(t));
      if (method !== 'POST') return err('Method not allowed', 405);
      if (action === 'subscribe') {
        const sub = body.subscription;
        if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
          return err('訂閱資料格式錯誤', 400);
        }
        t.pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
        await this.saveTicket(t);
        this.broadcast();
        return json({ ok: true });
      }
      if (action === 'test-push') {
        const ok = await this.push(t, { title: '通知測試成功 ✅', body: `叫到 ${t.number} 號時會像這樣通知你`, tag: `test-${t.id}` });
        return json({ ok });
      }
      if (action === 'cancel') {
        if (t.status !== 'done') this.meta.doneCount++;
        t.status = 'done';
        t.cancelled = true;
        await this.changed([this.saveTicket(t)]);
        return json(this.publicTicket(t));
      }
    }

    // ----- admin -----
    if (path === '/api/admin/status') return json({ pinConfigured: this.pinConfigured() });
    if (path === '/api/admin/setup' && method === 'POST') {
      if (this.pinConfigured()) return err('已經設定過密碼', 409);
      if (typeof body.pin !== 'string' || body.pin.length < 4 || body.pin.length > 64) return err('密碼至少 4 個字元', 400);
      await this.setPin(body.pin);
      return json({ ok: true });
    }
    if (path.startsWith('/api/admin/')) {
      const r = await this.checkPin(request.headers.get('x-admin-pin'));
      if (r === 'locked') return err('密碼錯誤太多次，請 1 分鐘後再試', 429);
      if (r !== 'ok') return err('密碼錯誤', 401);
      return this.admin(path.slice('/api/admin'.length), method, body);
    }

    return err('Not found', 404);
  }

  async admin(path, method, body) {
    if (path === '/state') return json(this.adminState());
    if (method !== 'POST') return err('Method not allowed', 405);

    if (path === '/call-next') {
      const next = this.waiting()[0];
      if (!next) return err('目前沒有等待中的來賓', 409);
      next.status = 'called';
      next.calledAt = Date.now();
      this.meta.nowServing = next.number;
      const pushed = this.notifyCalled(next);
      await this.changed([this.saveTicket(next)]);
      return json({ ticket: this.publicTicket(next), pushed: await pushed });
    }

    const m = path.match(/^\/tickets\/([\w-]+)\/(call|done|skip|requeue)$/);
    if (m) {
      const t = this.tickets.get(m[1]);
      if (!t) return err('找不到這張號碼牌', 404);
      let pushed;
      switch (m[2]) {
        case 'call':
          t.status = 'called';
          t.calledAt = Date.now();
          this.meta.nowServing = t.number;
          pushed = this.notifyCalled(t);
          break;
        case 'done':
          if (t.status !== 'done') this.meta.doneCount++;
          t.status = 'done';
          break;
        case 'skip':
          t.status = 'skipped';
          pushed = this.push(t, { title: `${t.number} 號已過號`, body: '請直接回到現場，找小幫手安排。', tag: `skip-${t.id}`, url: `/?t=${t.id}` });
          break;
        case 'requeue':
          t.status = 'waiting';
          t.notifiedNear = true; // already on site
          break;
      }
      await this.changed([this.saveTicket(t)]);
      return json({ ticket: this.publicTicket(t), pushed: pushed ? await pushed : undefined });
    }

    if (path === '/settings') {
      const { boothName, notifyAhead, avgMinutes, paused, newPin } = body;
      if (typeof boothName === 'string' && boothName.trim()) this.meta.boothName = boothName.trim().slice(0, 40);
      if (Number.isInteger(notifyAhead) && notifyAhead >= 0 && notifyAhead <= 50) this.meta.notifyAhead = notifyAhead;
      if (typeof avgMinutes === 'number' && avgMinutes >= 0 && avgMinutes <= 120) this.meta.avgMinutes = avgMinutes;
      if (typeof paused === 'boolean') this.meta.paused = paused;
      if (newPin !== undefined) {
        if (this.env.ADMIN_PIN) return err('密碼由 Cloudflare 環境變數 ADMIN_PIN 設定，請到後台修改', 400);
        if (typeof newPin !== 'string' || newPin.length < 4 || newPin.length > 64) return err('密碼至少 4 個字元', 400);
        await this.setPin(newPin);
      }
      await this.changed();
      return json(this.adminState());
    }

    if (path === '/reset') {
      const { boothName, notifyAhead, avgMinutes } = this.meta;
      await this.ctx.storage.delete([...this.tickets.keys()].map((id) => 't:' + id));
      this.tickets.clear();
      this.meta = { ...DEFAULT_META, boothName, notifyAhead, avgMinutes };
      await this.changed();
      return json(this.adminState());
    }

    return err('Not found', 404);
  }
}

export default {
  async fetch(request, env) {
    // Static files (public/) are served automatically; only API + manifest reach here.
    const stub = env.QUEUE.get(env.QUEUE.idFromName('main'));
    return stub.fetch(request);
  },
};
