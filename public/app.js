'use strict';
// Visitor screen logic. All text from the server is inserted with textContent (never innerHTML),
// so a malicious value cannot run as HTML or script (XSS protection).
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30000;          // R10: crowd level refreshes every 30 s (requirement: within 60 s)
const RING = 2 * Math.PI * 54;     // circumference of the gauge circle (r = 54)
const CLOSES_AT = 23;              // gyms close at 23:00 in the test data
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const params = new URLSearchParams(location.search);
const scannedQr = params.get('qr');          // set when the page was opened by scanning a door QR code
const scannedGym = Number(params.get('gym')) || null;

let gyms = [];
let lastUpdate = 0;
let lastLevel = null;

// localStorage can be blocked (private mode); the app must still work without it
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}

const pad = (h) => `${String(h).padStart(2, '0')}:00`;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// Every sound has a text twin: the message is always shown and announced (aria-live)
function say(message, kind = '') {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast ' + kind;
}

function beep() {
  if (!$('soundToggle').checked) return; // sound is off by default and plays only after a click
  const chime = $('chime');
  chime.currentTime = 0;
  chime.play().catch(() => {});
}

function selectedGymId() { return Number($('gymSelect').value); }

function renderSelectedGym() {
  const g = gyms.find((x) => x.gymId === selectedGymId());
  if (!g) return;
  $('insideCount').textContent = g.inside;
  $('capacity').textContent = g.capacity;
  const badge = $('levelBadge');
  badge.textContent = `${g.level} · ${g.percent}%`;   // the level is never shown by colour alone
  badge.className = 'level ' + g.level;
  $('srLevel').textContent = `${g.name}: ${g.inside} of ${g.capacity} people inside, ${g.level} crowd.`;
  const ring = $('ringValue');
  ring.style.strokeDashoffset = String(RING * (1 - Math.min(100, g.percent) / 100));
  ring.setAttribute('class', 'value ' + g.level);

  // R9: notify when the level drops to Low
  if ($('notifyLow').checked && lastLevel && lastLevel !== 'Low' && g.level === 'Low') {
    say(`${g.name} is now Low (${g.inside} people). Good time to go!`, 'ok');
    beep();
    try { if (window.Notification && Notification.permission === 'granted') new Notification('Gym Crowd Tracker', { body: `${g.name} is now Low.` }); } catch { /* ignore */ }
  }
  lastLevel = g.level;
}

function renderGymList() {
  $('gymList').replaceChildren(...gyms.map((g) => {
    const li = el('li');
    const b = el('button', 'gym-card');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(g.gymId === selectedGymId()));
    b.setAttribute('aria-label', `${g.name}: ${g.inside} of ${g.capacity} inside, ${g.level}`);
    const name = el('span', '', g.name);
    const bar = el('span', 'mini'); const fill = el('span', g.level); fill.style.width = Math.min(100, g.percent) + '%'; bar.append(fill);
    const meta = el('span', 'meta'); meta.append(el('span', '', `${g.inside}/${g.capacity}`), el('span', 'level ' + g.level, g.level));
    b.append(name, bar, meta);
    b.addEventListener('click', () => { $('gymSelect').value = g.gymId; onGymChange(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    li.append(b);
    return li;
  }));
}

async function refresh() {
  try {
    const data = await api('/api/gyms');
    gyms = data.gyms;
    if (!$('gymSelect').options.length) {
      for (const g of gyms) $('gymSelect').add(new Option(g.name, g.gymId));
      $('gymSelect').value = scannedGym || store.get('gymId') || gyms[0].gymId;
      loadHours();
    }
    renderSelectedGym();
    renderGymList();
    lastUpdate = Date.now();
    $('updatedAt').textContent = 'Updated at ' + data.updatedAt.slice(11, 16) + ' · every 30 s';
  } catch {
    $('updatedAt').textContent = 'Could not refresh – retrying in 30 s';
  }
}

// Usual arrivals for this weekday (R4), today's total and the best time to go.
// If one weekday has fewer than 20 past visits, the profile of all days is used instead (stated on screen).
async function loadHours() {
  const weekday = new Date().getDay();
  const nowHour = new Date().getHours();
  const gym = selectedGymId();
  let usual = await api(`/api/busy-hours?gym=${gym}&weekday=${weekday}`).catch(() => ({ hours: [], sampleVisits: 0 }));
  let scope = `${WEEKDAYS[weekday]}s`;
  if (usual.sampleVisits < 20) {
    usual = await api(`/api/busy-hours?gym=${gym}&weekday=all`).catch(() => ({ hours: [], sampleVisits: 0 }));
    scope = 'all days';
  }
  const today = await api(`/api/today?gym=${gym}`).catch(() => ({ hours: [] }));
  $('weekdayName').textContent = scope === 'all days' ? 'All days' : WEEKDAYS[weekday];
  const usualBy = new Map(usual.hours.map((h) => [h.hour, h.avgArrivals]));
  const hours = Array.from({ length: CLOSES_AT - 7 }, (_, i) => i + 7);   // 07:00 ... 22:00
  const max = Math.max(0.1, ...hours.map((h) => usualBy.get(h) || 0));
  $('busyChart').replaceChildren(...hours.map((h) => {
    const u = usualBy.get(h) || 0;
    const li = el('li', h === nowHour ? 'now' : '');
    li.title = `${pad(h)}: on average ${u} arrivals per hour`;
    const col = el('span', 'col' + (u === max ? ' today' : '')); col.style.height = Math.max(3, (u / max) * 100) + '%';
    li.append(el('span', 'num', ''), col, el('span', 'lab', h % 3 === 1 ? String(h) : ''));
    return li;
  }));
  const todayTotal = today.hours.reduce((s, h) => s + h.arrivals, 0);
  const left = hours.filter((h) => h > nowHour && h < CLOSES_AT);
  if (left.length && usual.hours.length) {
    const best = left.reduce((a, b) => ((usualBy.get(b) || 0) < (usualBy.get(a) || 0) ? b : a));
    $('bestTime').textContent = `Best time to go today: ${pad(best)} – the quietest hour left on ${scope}.`;
  } else {
    $('bestTime').textContent = nowHour >= CLOSES_AT - 1 ? 'The gym closes soon. Come back tomorrow morning.' : 'Not enough data yet.';
  }
  const peak = [...usual.hours].sort((a, b) => b.avgArrivals - a.avgArrivals)[0];
  $('quietHint').textContent = usual.hours.length
    ? `Usual pattern on ${scope} (${usual.sampleVisits} past visits). Busiest: ${pad(peak.hour)}. Today so far: ${todayTotal} check-ins.`
    : `Today so far: ${todayTotal} check-ins.`;
}

function currentCode() { return $('codeInput').value.trim().toUpperCase(); }

async function checkIn() {
  const code = currentCode();
  if (!code) return say('Enter your visitor code first, for example V-0001.', 'err');
  await act(() => api('/api/checkin', { code, gymId: selectedGymId(), qr: usableQr('in') }));
}

async function checkOut() {
  const code = currentCode();
  if (!code) return say('Enter your visitor code first, for example V-0001.', 'err');
  await act(() => api('/api/checkout', { code, qr: usableQr('out') }));
}

function usableQr(type) {
  return scannedQr && scannedQr.toLowerCase().startsWith(type + '-') ? scannedQr : undefined;
}

async function act(call) {
  const buttons = [$('checkInBtn'), $('checkOutBtn')];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const data = await call();
    store.set('visitorCode', currentCode());
    say(data.message, 'ok');
    beep();
    const i = gyms.findIndex((g) => g.gymId === data.gym.gymId);
    if (i >= 0) gyms[i] = data.gym;
    renderSelectedGym();
    renderGymList();
    loadHours();
    if (!$('myBox').classList.contains('hidden')) loadMyVisits();
  } catch (e) {
    say(e.message, 'err');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function newCode() {
  if (!$('consent').checked) return say('Please tick the privacy notice first.', 'err');
  try {
    const data = await api('/api/visitors', { consent: true, gymId: selectedGymId() });
    $('codeInput').value = data.code;
    store.set('visitorCode', data.code);
    say(`Your anonymous code is ${data.code}. It is saved on this phone.`, 'ok');
  } catch (e) { say(e.message, 'err'); }
}

async function loadMyVisits() {
  const code = currentCode();
  if (!code) { $('myHint').textContent = 'Enter your visitor code above first.'; return; }
  try {
    const d = await api('/api/my-visits', { code });
    $('myBox').classList.remove('hidden');
    $('myVisits').textContent = d.visits;
    $('myHours').textContent = `${Math.round((d.minutes / 60) * 10) / 10} h`;
    $('myWeek').textContent = d.last7;
    $('myFav').textContent = d.favouriteGym ? `Favourite gym: ${d.favouriteGym}` : 'No visits yet – check in to start your history.';
    $('myHint').textContent = `History for ${d.code}. Only someone with your code can see it.`;
    $('myList').replaceChildren(...d.recent.map((v) => {
      const li = el('li');
      const when = `${v.checkIn.slice(5, 10)} ${v.checkIn.slice(11, 16)}`;
      const dur = v.checkOut ? `${v.minutes} min${v.auto ? ' (auto)' : ''}` : 'inside now';
      li.append(el('span', '', `${v.gym} · ${when}`), el('span', '', dur));
      return li;
    }));
  } catch (e) { $('myHint').textContent = e.message; }
}

function onGymChange() {
  store.set('gymId', selectedGymId());
  lastLevel = null;
  renderSelectedGym();
  renderGymList();
  loadHours();
}

// ----- start -----
$('codeInput').value = store.get('visitorCode') || '';
if (store.get('visitorCode')) $('newCodeBox').classList.add('hidden');
$('soundToggle').checked = store.get('sound') === 'on';
$('soundToggle').addEventListener('change', () => store.set('sound', $('soundToggle').checked ? 'on' : 'off'));
$('notifyLow').addEventListener('change', () => {
  if ($('notifyLow').checked && window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
});
$('gymSelect').addEventListener('change', onGymChange);
$('checkInBtn').addEventListener('click', checkIn);
$('checkOutBtn').addEventListener('click', checkOut);
$('newCodeBtn').addEventListener('click', newCode);
$('myBtn').addEventListener('click', loadMyVisits);

if (scannedQr) {
  const banner = $('qrBanner');
  banner.textContent = scannedQr.startsWith('IN-')
    ? 'Entrance QR code scanned. Enter your code (or get one) and tap "Check in".'
    : 'Exit QR code scanned. Tap "Check out".';
  banner.classList.remove('hidden');
}

refresh();
setInterval(refresh, REFRESH_MS);
setInterval(loadHours, REFRESH_MS * 4);
// stale-data warning (visibility of system status, Nielsen #1)
setInterval(() => { $('staleWarning').classList.toggle('hidden', Date.now() - lastUpdate < 90000); }, 5000);
