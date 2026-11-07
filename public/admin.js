'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const PIN_KEY = 'queue-admin-pin';
  let pin = '';
  let state = null;
  try { pin = localStorage.getItem(PIN_KEY) || ''; } catch (e) {}

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  async function api(path, body) {
    const res = await fetch('/api/admin' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { pin = ''; try { localStorage.removeItem(PIN_KEY); } catch (e) {} showLogin(); throw new Error('密碼錯誤'); }
    if (!res.ok) throw new Error(data.error || '操作失敗');
    return data;
  }

  function showLogin() {
    $('setup').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('panel').classList.add('hidden');
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '');

  function row(t, actions) {
    const div = document.createElement('div');
    div.className = 'ticket-row';
    const push = t.hasPush ? '🔔' : '<span title="未開啟通知">🔕</span>';
    const info = t.status === 'called' ? `叫號 ${fmtTime(t.calledAt)}` : `取號 ${fmtTime(t.createdAt)}`;
    div.innerHTML = `<span class="num">${t.number}</span><span class="info">${push} ${info}</span><span class="actions"></span>`;
    const box = div.querySelector('.actions');
    actions.forEach(([label, action, cls]) => {
      const b = document.createElement('button');
      b.className = 'btn small ' + (cls || '');
      b.textContent = label;
      b.onclick = () => act(t, action);
      box.appendChild(b);
    });
    return div;
  }

  function fill(id, tickets, actions) {
    const el = $(id);
    el.innerHTML = '';
    if (!tickets.length) { el.innerHTML = '<p class="muted">無</p>'; return; }
    tickets.forEach((t) => el.appendChild(row(t, actions)));
  }

  function render(s) {
    state = s;
    $('login').classList.add('hidden');
    $('setup').classList.add('hidden');
    $('panel').classList.remove('hidden');
    $('booth-name').textContent = s.boothName;
    $('now-serving').textContent = s.nowServing || '—';
    const waiting = s.tickets.filter((t) => t.status === 'waiting');
    $('waiting-count').textContent = waiting.length;
    $('done-count').textContent = s.doneCount;
    $('next-number').textContent = s.nextNumber;
    $('btn-call-next').disabled = waiting.length === 0;
    $('btn-call-next').textContent = waiting.length ? `📣 叫下一號（${waiting[0].number} 號）` : '目前沒有等待的來賓';
    $('paused-msg').classList.toggle('hidden', !s.paused);
    $('btn-pause').textContent = s.paused ? '恢復取號' : '暫停取號';
    $('guest-url').textContent = guestUrl;

    fill('list-called', s.tickets.filter((t) => t.status === 'called').sort((a, b) => b.calledAt - a.calledAt), [
      ['✅ 完成', 'done', 'ok'],
      ['🔁 再叫一次', 'call', 'secondary'],
      ['過號', 'skip', 'ghost'],
    ]);
    fill('list-waiting', waiting, [['叫這號', 'call', 'secondary']]);
    fill('list-skipped', s.tickets.filter((t) => t.status === 'skipped'), [
      ['排回隊伍', 'requeue', 'secondary'],
      ['叫號', 'call', 'ghost'],
      ['完成', 'done', 'ghost'],
    ]);

    if (document.activeElement.tagName !== 'INPUT') {
      $('set-name').value = s.boothName;
      $('set-ahead').value = s.notifyAhead;
      $('set-avg').value = s.avgMinutes;
    }
  }

  const guestUrl = location.origin + '/';
  function drawQr() {
    if (!window.qrcode || $('admin-qr').innerHTML) return;
    const qr = qrcode(0, 'M');
    qr.addData(guestUrl);
    qr.make();
    $('admin-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  async function load() {
    if (!pin) {
      const st = await fetch('/api/admin/status').then((r) => r.json()).catch(() => ({ pinConfigured: true }));
      if (!st.pinConfigured) {
        $('setup').classList.remove('hidden');
        $('login').classList.add('hidden');
        return;
      }
      return showLogin();
    }
    try {
      render(await api('/state'));
      drawQr();
      connectLive();
    } catch (e) { if (e.message !== '密碼錯誤') toast(e.message); }
  }

  // ----- live updates over WebSocket -----
  let ws = null;
  let retry = 1000;
  function connectLive() {
    if (ws && ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/api/ws?role=admin&pin=${encodeURIComponent(pin)}`);
    ws.onopen = () => { retry = 1000; };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try { const m = JSON.parse(e.data); if (m.type === 'admin') render(m.data); } catch (err) {}
    };
    ws.onclose = () => { ws = null; if (pin) setTimeout(connectLive, retry); retry = Math.min(retry * 2, 30000); };
  }
  setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 50000);
  setInterval(() => { if (pin && (!ws || ws.readyState !== 1)) load(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && pin) load(); });

  $('setup-form').onsubmit = async (e) => {
    e.preventDefault();
    const a = $('setup-pin').value;
    if (a !== $('setup-pin2').value) return toast('兩次輸入的密碼不一樣');
    const res = await fetch('/api/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: a }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || '設定失敗'); return load(); }
    pin = a;
    try { localStorage.setItem(PIN_KEY, pin); } catch (err) {}
    toast('密碼設定完成 ✅');
    load();
  };

  $('btn-pin').onclick = async () => {
    const np = $('set-pin').value;
    if (np.length < 4) return toast('密碼至少 4 個字元');
    try {
      await api('/settings', { newPin: np });
      pin = np;
      try { localStorage.setItem(PIN_KEY, pin); } catch (err) {}
      $('set-pin').value = '';
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      connectLive();
      toast('密碼已更新');
    } catch (e) { toast(e.message); }
  };

  async function act(t, action) {
    try {
      const r = await api(`/tickets/${encodeURIComponent(t.id)}/${action}`, {});
      if (action === 'call') toast(r.pushed ? `已通知 ${t.number} 號 🔔` : `已叫 ${t.number} 號（對方未開啟通知）`);
      load();
    } catch (e) { toast(e.message); }
  }

  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    pin = $('pin').value;
    try {
      await api('/state');
      try { localStorage.setItem(PIN_KEY, pin); } catch (err) {}
      load();
    } catch (err) { toast(err.message); }
  };

  $('btn-call-next').onclick = async () => {
    const btn = $('btn-call-next');
    btn.disabled = true;
    try {
      const r = await api('/call-next', {});
      toast(r.pushed ? `已通知 ${r.ticket.number} 號 🔔` : `已叫 ${r.ticket.number} 號（對方未開啟通知）`);
    } catch (e) { toast(e.message); }
    load();
  };

  $('btn-save').onclick = async () => {
    try {
      render(await api('/settings', {
        boothName: $('set-name').value,
        notifyAhead: parseInt($('set-ahead').value, 10),
        avgMinutes: parseFloat($('set-avg').value),
      }));
      toast('已儲存');
    } catch (e) { toast(e.message); }
  };

  $('btn-pause').onclick = async () => {
    try { render(await api('/settings', { paused: !state.paused })); } catch (e) { toast(e.message); }
  };

  $('btn-reset').onclick = async () => {
    if (!confirm('確定要清空所有號碼並從 1 號重新開始嗎？此動作無法復原。')) return;
    try { render(await api('/reset', {})); toast('已重置'); } catch (e) { toast(e.message); }
  };

  $('btn-logout').onclick = () => {
    pin = '';
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    try { localStorage.removeItem(PIN_KEY); } catch (e) {}
    showLogin();
  };

  load();
})();
