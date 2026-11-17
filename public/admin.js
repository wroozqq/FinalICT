'use strict';
// Staff dashboard: sign-in, statistics, QR codes, sensor simulation, staff accounts.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${data.error || 'error'}`), { status: res.status });
  return data;
}

function show(box, msg, kind) { box.textContent = msg; box.className = 'toast ' + (kind || ''); }

// Horizontal bar chart from rows [{label, value}] built from DOM elements + textContent.
// The largest value is highlighted, so the answer to the question is visible at a glance.
function bars(listId, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  $(listId).replaceChildren(...rows.map((r) => {
    const li = el('li', r.value === max ? 'top' : '');
    const name = el('span', 'name', r.label); name.title = r.label;
    const track = el('span', 'track'); const fill = el('span', 'fill'); fill.style.width = (r.value / max) * 100 + '%'; track.append(fill);
    li.append(name, track, el('span', 'val', String(r.value)));
    return li;
  }));
}

async function loadDashboard() {
  const a = await api('/api/analytics');
  $('kOpen').textContent = a.summary.open;
  $('kToday').textContent = a.summary.today;
  $('kDone').textContent = a.summary.completed;
  $('kAuto').textContent = a.summary.auto_closed;
  $('liveList').replaceChildren(...a.live.map((g) => {
    const li = el('li');
    const meta = el('span', 'meta');
    meta.append(el('span', '', `${g.name} · ${g.inside}/${g.capacity}`), el('span', 'level ' + g.level, `${g.level} ${g.percent}%`));
    const bar = el('span', 'mini'); const fill = el('span', g.level); fill.style.width = Math.min(100, g.percent) + '%'; bar.append(fill);
    li.append(meta, bar);
    return li;
  }));
  bars('dailyChart', a.daily.map((d) => ({ label: d.day.slice(5), value: d.visits })));
  bars('hourChart', a.hourly.map((h) => ({ label: `${String(h.hour).padStart(2, '0')}:00`, value: h.visits })));
  bars('gymChart', a.byGym.map((g) => ({ label: g.gym, value: g.visits })));
  bars('durChart', a.duration.map((g) => ({ label: g.gym, value: g.average_minutes })));
  $('sqlHourly').textContent = a.queries.hourly.trim();
  $('sqlByGym').textContent = a.queries.byGym.trim();
  $('sqlDuration').textContent = a.queries.duration.trim();
  await Promise.all([loadReadings(), loadQr(), loadStaff()]);
}

async function loadReadings() {
  const { readings } = await api('/api/sensor/readings');
  $('readings').replaceChildren(...readings.map((r) => {
    const tr = el('tr');
    [r.reading_id, r.gym_name, r.estimated_occupancy, r.reading_at.slice(11), r.quality_flag].forEach((v) => tr.append(el('td', '', String(v))));
    return tr;
  }));
}

async function loadQr() {
  const { codes, base, phoneReady } = await api('/api/admin/qr');
  $('qrBase').textContent = phoneReady
    ? `QR codes open ${base} – a phone on the same Wi-Fi can scan them.`
    : `QR codes open ${base}, which only this computer can reach. For phones: stop the server and start it with "npm run phone".`;
  $('qrGrid').replaceChildren(...codes.map((c) => {
    const box = el('div', 'qr-item');
    const img = el('img');
    img.src = `/api/admin/qr/${c.code_id}.svg`;
    img.alt = `${c.code_type === 'in' ? 'Entrance' : 'Exit'} QR code for ${c.gym_name}`;
    const caption = el('div', '', `${c.gym_name} · ${c.code_type === 'in' ? 'ENTRANCE' : 'EXIT'}`);
    const row = el('div', 'row');
    const poster = el('a', 'pill-link', 'Poster');
    poster.href = `/poster.html?id=${c.code_id}`; poster.target = '_blank'; poster.rel = 'noopener';
    const btn = el('button', 'secondary small', 'New code');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      try { await api('/api/admin/qr/rotate', { gymId: c.gym_id, type: c.code_type }); show($('qrMsg'), `New ${c.code_type} code created for ${c.gym_name}. The old one no longer works.`, 'ok'); loadQr(); }
      catch (e) { show($('qrMsg'), e.message, 'err'); }
    });
    row.append(poster, btn);
    box.append(img, caption, row);
    return box;
  }));
}

async function loadStaff() {
  try {
    const { users } = await api('/api/admin/users');
    $('staffTable').replaceChildren(...users.map((u) => {
      const tr = el('tr');
      [u.admin_id, u.username, u.role, u.last_login_at || '–'].forEach((v) => tr.append(el('td', '', String(v))));
      return tr;
    }));
  } catch (e) {
    $('staffTable').replaceChildren();
    show($('staffMsg'), e.status === 403 ? 'HTTP 403: only an admin can see and register staff accounts.' : e.message, 'err');
  }
}

function signedIn(user) {
  $('loginCard').classList.add('hidden');
  $('dash').classList.remove('hidden');
  $('whoami').textContent = `Signed in as ${user.username}`;
  $('whoSmall').textContent = `${user.username} · ${user.role}`;
  $('roleHint').textContent = user.role === 'admin'
    ? 'Role: admin – statistics, QR codes, sensor readings and staff accounts.'
    : 'Role: analyst – read-only access to statistics.';
  loadDashboard().catch((e) => show($('simMsg'), e.message, 'err'));
}

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const user = await api('/api/login', { username: $('username').value, password: $('password').value });
    $('password').value = '';
    signedIn(user);
  } catch (e) { show($('loginMsg'), e.message, 'err'); }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  location.reload();
});

$('simBtn').addEventListener('click', async () => {
  try {
    const r = await api('/api/sensor/simulate', {});
    show($('simMsg'), `${r.inserted} simulated readings saved.`, 'ok');
    loadReadings();
  } catch (e) { show($('simMsg'), e.message, 'err'); }
});

$('staffForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await api('/api/admin/users', { username: $('newUser').value, password: $('newPass').value, role: $('newRole').value });
    show($('staffMsg'), `Staff member "${r.username}" (${r.role}) registered and saved in admin_user.`, 'ok');
    $('newUser').value = ''; $('newPass').value = '';
    loadStaff();
  } catch (e) { show($('staffMsg'), e.message, 'err'); }
});

// Already signed in (cookie still valid)? Then open the dashboard directly.
api('/api/me').then(signedIn).catch(() => {});
setInterval(() => { if (!$('dash').classList.contains('hidden')) loadDashboard().catch(() => {}); }, 30000);
