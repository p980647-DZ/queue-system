'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'queue-ticket-id';
  const STATUS_TEXT = { waiting: '等待中', called: '輪到你了！', skipped: '已過號', done: '已完成' };

  let config = null;
  let ticketId = null;
  let lastStatus = null;
  let swReg = null;
  let audioCtx = null;

  const store = {
    get() { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } },
    set(v) { try { v ? localStorage.setItem(STORE_KEY, v) : localStorage.removeItem(STORE_KEY); } catch (e) {} },
  };

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || '連線失敗'), { status: res.status });
    return data;
  }

  // ----- Platform detection -----
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // ----- Sound / vibration when the page is open -----
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  function alertBeep() {
    if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 800]);
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [0, 0.35, 0.7].forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.3, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.3);
    });
  }
  document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
  document.addEventListener('click', unlockAudio, { once: true });

  // ----- Rendering -----
  function renderTake() {
    $('take').classList.remove('hidden');
    $('ticket').classList.add('hidden');
    $('take-serving').textContent = config.nowServing || '—';
    $('take-waiting').textContent = config.waiting;
    $('take-eta').textContent = Math.round(config.waiting * config.avgMinutes);
    $('btn-take').disabled = config.paused;
    $('take-paused').classList.toggle('hidden', !config.paused);
    $('take-paused').textContent = '目前暫停取號，請洽現場工作人員。';
  }

  function renderTicket(t) {
    $('take').classList.add('hidden');
    $('ticket').classList.remove('hidden');
    $('booth').textContent = t.boothName;
    document.title = `${t.number} 號 - ${t.boothName}`;
    $('my-number').textContent = t.number;
    $('now-serving').textContent = t.nowServing || '—';
    $('ahead').textContent = t.ahead;
    $('eta').textContent = Math.round(t.estimatedMinutes);

    const badge = $('status-badge');
    badge.textContent = STATUS_TEXT[t.status] || t.status;
    badge.className = 'badge ' + t.status;

    const card = $('ticket-card');
    card.classList.toggle('called-banner', t.status === 'called');
    $('stats-card').classList.toggle('hidden', t.status !== 'waiting');

    let msg = '';
    if (t.status === 'waiting') {
      if (t.ahead === 0) msg = '下一位就是你，請立即返回現場！';
      else if (t.ahead <= t.notifyAhead) msg = `前面剩 ${t.ahead} 組，請返回現場排隊`;
      else msg = `前面剩 ${t.notifyAhead} 組時會通知你，可先離開逛逛`;
    } else if (t.status === 'called') msg = '請回到攤位，出示此頁面號碼';
    else if (t.status === 'skipped') msg = '請直接回到現場，找小幫手安排';
    else if (t.status === 'done') msg = '感謝你的光臨！';
    $('status-msg').textContent = msg;

    const finished = t.status === 'done';
    $('notify-card').classList.toggle('hidden', finished);
    $('btn-cancel').classList.toggle('hidden', finished);
    if (finished) {
      store.set(null);
      // offer a fresh ticket
      if (!$('btn-new')) {
        const b = document.createElement('button');
        b.id = 'btn-new';
        b.className = 'btn secondary';
        b.style.marginTop = '12px';
        b.textContent = '重新取號';
        b.onclick = () => { history.replaceState(null, '', '/'); ticketId = null; lastStatus = null; b.remove(); refresh(); };
        card.appendChild(b);
      }
    }

    // Alert when called while page is open (push handles the background case)
    if (lastStatus && lastStatus !== 'called' && t.status === 'called') {
      alertBeep();
      if (document.visibilityState !== 'visible' && swReg && Notification.permission === 'granted') {
        swReg.showNotification(`輪到你了！${t.number} 號`, { body: '請回到攤位出示此頁面號碼', tag: 'called-' + t.id });
      }
    }
    lastStatus = t.status;
    renderNotify(t);
  }

  function renderNotify(t) {
    const btn = $('btn-notify');
    const msg = $('notify-msg');
    $('ios-hint').classList.add('hidden');
    if (!pushSupported) {
      btn.classList.add('hidden');
      if (isIOS && !isStandalone) {
        msg.textContent = '此頁開著時有聲音和震動提醒；想鎖定手機也收到通知，請依下列步驟操作。';
        $('ios-hint').classList.remove('hidden');
      } else {
        msg.textContent = '此瀏覽器不支援推播通知，請保持此頁開啟（會有聲音和震動提醒），或定時回來查看。';
      }
      return;
    }
    btn.classList.remove('hidden');
    if (Notification.permission === 'denied') {
      msg.textContent = '通知已被封鎖，請到瀏覽器設定允許此網站的通知。';
      btn.classList.add('hidden');
    } else if (t.hasPush && Notification.permission === 'granted') {
      msg.textContent = '✅ 通知已開啟，可以安心離開，輪到你時手機會跳出通知。';
      btn.textContent = '傳送測試通知';
      btn.className = 'btn secondary';
      btn.dataset.mode = 'test';
    } else {
      msg.textContent = '開啟通知後，即使離開攤位、手機鎖定，輪到你時也會跳出通知。';
      btn.textContent = '開啟通知';
      btn.className = 'btn';
      btn.dataset.mode = 'enable';
    }
  }

  // ----- Data -----
  async function refresh() {
    try {
      if (ticketId) {
        const t = await api('/api/tickets/' + encodeURIComponent(ticketId));
        renderTicket(t);
      } else {
        config = await api('/api/config');
        $('booth').textContent = config.boothName;
        document.querySelectorAll('.n-ahead').forEach((el) => (el.textContent = config.notifyAhead));
        document.title = config.boothName;
        renderTake();
      }
      $('conn').textContent = '';
    } catch (err) {
      if (err.status === 404) {
        store.set(null);
        ticketId = null;
        history.replaceState(null, '', '/');
        toast('找不到號碼牌，請重新取號');
        return refresh();
      }
      $('conn').textContent = '⚠️ 連線中斷，重新連線中…';
    }
  }

  function setTicket(id) {
    ticketId = id;
    store.set(id);
    history.replaceState(null, '', '/?t=' + encodeURIComponent(id));
    // So "加入主畫面" opens this ticket directly
    $('manifest').href = '/manifest.webmanifest?t=' + encodeURIComponent(id);
  }

  $('btn-take').onclick = async () => {
    const btn = $('btn-take');
    btn.disabled = true;
    try {
      const t = await api('/api/tickets', { method: 'POST', body: { existingId: store.get() } });
      setTicket(t.id);
      renderTicket(t);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  };

  $('btn-cancel').onclick = async () => {
    if (!confirm('確定要取消排隊嗎？取消後號碼將失效。')) return;
    await api('/api/tickets/' + encodeURIComponent(ticketId) + '/cancel', { method: 'POST' });
    refresh();
  };

  function urlBase64ToUint8Array(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  $('btn-notify').onclick = async () => {
    const btn = $('btn-notify');
    if (btn.dataset.mode === 'test') {
      const r = await api('/api/tickets/' + encodeURIComponent(ticketId) + '/test-push', { method: 'POST' });
      toast(r.ok ? '已送出測試通知' : '測試失敗，請重新開啟通知');
      if (!r.ok) refresh();
      return;
    }
    btn.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('未允許通知');
      swReg = swReg || (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      if (!config) config = await api('/api/config');
      let sub = await swReg.pushManager.getSubscription();
      if (!sub) {
        sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
        });
      }
      await api('/api/tickets/' + encodeURIComponent(ticketId) + '/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      toast('通知已開啟 ✅');
    } catch (err) {
      toast('開啟通知失敗：' + err.message);
    } finally {
      btn.disabled = false;
      refresh();
    }
  };

  // ----- Live updates -----
  function connectEvents() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events');
    let timer = null;
    es.onmessage = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };
    es.onopen = () => { $('conn').textContent = ''; };
    es.onerror = () => { $('conn').textContent = '⚠️ 連線中斷，重新連線中…'; };
  }
  setInterval(refresh, 20000); // fallback polling
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

  // ----- Boot -----
  (async function init() {
    if (pushSupported) {
      try { swReg = await navigator.serviceWorker.register('/sw.js'); } catch (e) {}
    }
    const fromUrl = new URLSearchParams(location.search).get('t');
    const id = fromUrl || store.get();
    if (id) setTicket(id);
    try { config = await api('/api/config'); } catch (e) {}
    await refresh();
    connectEvents();
  })();
})();
