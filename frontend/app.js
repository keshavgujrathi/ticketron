// Ticketron frontend — single-file vanilla JS SPA (no build step, so the
// whole app can be served as static files by the same Node process as the
// API and deployed as one service). Hash-based routing.

const API = '/api';
const state = {
  token: localStorage.getItem('tk_token') || null,
  user: JSON.parse(localStorage.getItem('tk_user') || 'null'),
  socket: null,
};

function saveAuth(token, user) {
  state.token = token; state.user = user;
  localStorage.setItem('tk_token', token);
  localStorage.setItem('tk_user', JSON.stringify(user));
}
function clearAuth() {
  state.token = null; state.user = null;
  localStorage.removeItem('tk_token'); localStorage.removeItem('tk_user');
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(API + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Request failed'); err.data = data; throw err; }
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtMoney(n) { return `₹${n}`; }

// ---------- Nav ----------
function renderNav() {
  const nav = document.getElementById('nav');
  if (!state.user) {
    nav.innerHTML = `<a href="#/">Browse</a><a href="#/login">Log in</a><a href="#/register">Register</a>`;
    return;
  }
  const links = [`<a href="#/">Browse</a>`];
  if (state.user.role === 'customer') links.push(`<a href="#/bookings">My tickets</a>`);
  if (state.user.role === 'organiser' || state.user.role === 'admin') links.push(`<a href="#/organiser">Organiser</a>`);
  if (state.user.role === 'admin') links.push(`<a href="#/admin">Admin</a>`);
  links.push(`<span class="nav-tag">${state.user.name} · ${state.user.role}</span>`);
  links.push(`<button class="linklike" id="logoutBtn">Log out</button>`);
  nav.innerHTML = links.join('');
  const lb = document.getElementById('logoutBtn');
  if (lb) lb.onclick = () => { clearAuth(); renderNav(); location.hash = '#/'; };
}

// ---------- Router ----------
const routes = [];
function route(pattern, handler) { routes.push({ pattern, handler }); }
function matchRoute(hash) {
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) return { handler: r.handler, params: m.slice(1) };
  }
  return null;
}
async function render() {
  const hash = location.hash || '#/';
  const app = document.getElementById('app');
  const m = matchRoute(hash);
  renderNav();
  if (!m) { app.innerHTML = `<div class="empty">Nothing here.</div>`; return; }
  try {
    await m.handler(app, ...m.params);
  } catch (e) {
    app.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}
window.addEventListener('hashchange', render);

// ================= BROWSE =================
route(/^#\/$/, async (app) => {
  const q = new URLSearchParams(location.search);
  app.innerHTML = `
    <div class="eyebrow">Now booking</div>
    <h1>Find your seat</h1>
    ${!state.user ? `
    <div class="empty" style="text-align:left; margin:18px 0;">
      Not signed in. <a href="#/login">Log in with a demo account</a> to select seats,
      or keep browsing — events and seat maps are visible to everyone.
    </div>` : ''}
    <div class="form-row" style="margin:18px 0 26px;">
      <div class="field" style="margin:0;"><input id="q" placeholder="Search by title…" /></div>
      <div class="field" style="margin:0; max-width:180px;">
        <select id="typeFilter"><option value="">All types</option><option value="movie">Movies</option><option value="concert">Concerts</option></select>
      </div>
    </div>
    <div class="grid cols-2" id="eventList"></div>
  `;
  const listEl = document.getElementById('eventList');
  async function load() {
    const type = document.getElementById('typeFilter').value;
    const search = document.getElementById('q').value;
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (search) params.set('q', search);
    const events = await api(`/events?${params}`);
    if (!events.length) { listEl.innerHTML = `<div class="empty">No events match. Try a different search.</div>`; return; }
    listEl.innerHTML = events.map(e => `
      <a href="#/event/${e.id}" class="stub" style="text-decoration:none; color:inherit;">
        <div class="stub-main">
          <span class="badge ${e.type}">${e.type}</span>
          <h3 style="margin-top:8px; text-transform:none; letter-spacing:0; font-size:19px; color:var(--text);">${e.title}</h3>
          <p class="muted" style="margin:4px 0;">${e.venue_name}</p>
          ${e.next_show ? `<p class="mono" style="font-size:12px; color:var(--gold-dim);">Next: ${fmtDate(e.next_show)}</p>` : `<p class="muted" style="font-size:12px;">No shows scheduled</p>`}
        </div>
        <div class="stub-stub"><span class="code">TICKETRON</span></div>
      </a>
    `).join('');
  }
  document.getElementById('q').addEventListener('input', debounce(load, 250));
  document.getElementById('typeFilter').addEventListener('change', load);
  load();
});

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ================= AUTH =================
route(/^#\/login$/, async (app) => {
  app.innerHTML = authForm('login');
  bindAuthForm('login');
  bindQuickLogin();
});
route(/^#\/register$/, async (app) => {
  app.innerHTML = authForm('register');
  bindAuthForm('register');
});

// One-click sign-in as any seeded demo account — removes the need to type
// credentials out of a README to explore the different roles.
const DEMO_ACCOUNTS = [
  { label: 'Admin', email: 'admin@ticketron.dev', password: 'admin123', hint: 'venue setup, hold recovery' },
  { label: 'Organiser — Cinema', email: 'organiser@ticketron.dev', password: 'organiser123', hint: 'movies, revenue' },
  { label: 'Organiser — Music', email: 'promoter@ticketron.dev', password: 'organiser123', hint: 'concerts, revenue' },
  { label: 'Customer 1', email: 'customer1@ticketron.dev', password: 'password123', hint: 'book, cancel, waitlist' },
  { label: 'Customer 2', email: 'customer2@ticketron.dev', password: 'password123', hint: 'a second customer, for testing concurrency/waitlist together' },
];
function bindQuickLogin() {
  document.querySelectorAll('button[data-demo]').forEach(btn => {
    btn.onclick = async () => {
      const acc = DEMO_ACCOUNTS[Number(btn.dataset.demo)];
      try {
        const data = await api('/auth/login', { method: 'POST', body: { email: acc.email, password: acc.password } });
        saveAuth(data.token, data.user);
        location.hash = '#/';
      } catch (e) { toast(`Couldn't sign in as ${acc.label} — run "npm run seed" first if you haven't yet.`); }
    };
  });
}

function authForm(mode) {
  return `
    <div class="eyebrow">${mode === 'login' ? 'Welcome back' : 'Get started'}</div>
    <h1>${mode === 'login' ? 'Log in' : 'Create an account'}</h1>
    ${mode === 'login' ? `
    <div class="stub" style="max-width:460px; margin:20px 0;">
      <div class="stub-main">
        <h3 style="margin-bottom:10px;">Explore as a demo account</h3>
        <p class="muted" style="font-size:13px; margin-bottom:14px;">No typing required — pick a role to see what that person sees. Requires <code>npm run seed</code> to have been run once on this server.</p>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${DEMO_ACCOUNTS.map((a, i) => `
            <button class="btn" data-demo="${i}" style="text-align:left; display:flex; justify-content:space-between; align-items:center;">
              <span>${a.label}</span><span class="muted mono" style="font-size:10px; font-weight:normal; text-transform:none; letter-spacing:0;">${a.hint}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="stub-stub"><span class="code">QUICK ACCESS</span></div>
    </div>
    <p class="muted" style="margin:20px 0 6px;">— or log in manually —</p>
    ` : ''}
    <form id="authForm" style="max-width:380px; margin-top:12px;">
      ${mode === 'register' ? `<div class="field"><label>Name</label><input name="name" required/></div>` : ''}
      <div class="field"><label>Email</label><input name="email" type="email" required/></div>
      <div class="field"><label>Password</label><input name="password" type="password" required/></div>
      ${mode === 'register' ? `
      <div class="field"><label>Account type</label>
        <select name="role"><option value="customer">Customer — book tickets</option><option value="organiser">Organiser — list events</option></select>
      </div>` : ''}
      <button class="btn primary" type="submit">${mode === 'login' ? 'Log in' : 'Register'}</button>
      <p class="error-text" id="authError"></p>
    </form>
    <p class="muted" style="margin-top:14px;">${mode === 'login' ? `No account? <a href="#/register">Register</a>` : `Already have one? <a href="#/login">Log in</a>`}</p>
  `;
}
function bindAuthForm(mode) {
  document.getElementById('authForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = Object.fromEntries(fd.entries());
    try {
      const data = await api(`/auth/${mode}`, { method: 'POST', body });
      saveAuth(data.token, data.user);
      location.hash = '#/';
    } catch (e) { document.getElementById('authError').textContent = e.message; }
  });
}

// ================= EVENT DETAIL =================
route(/^#\/event\/(.+)$/, async (app, eventId) => {
  const event = await api(`/events/${eventId}`);
  app.innerHTML = `
    <a href="#/" class="muted" style="font-size:12px; text-decoration:none;">&larr; Browse</a>
    <div class="eyebrow" style="margin-top:10px;">${event.type} · ${event.venue_name}</div>
    <h1>${event.title}</h1>
    <p class="muted">${event.description || ''}</p>
    <h3 class="section-gap">Showtimes</h3>
    <div class="grid cols-2" id="shows"></div>
  `;
  const showsEl = document.getElementById('shows');
  if (!event.shows.length) { showsEl.innerHTML = `<div class="empty">No showtimes scheduled yet.</div>`; return; }
  showsEl.innerHTML = event.shows.map(s => `
    <a href="#/show/${s.id}?event=${eventId}" class="stub" style="text-decoration:none; color:inherit;">
      <div class="stub-main">
        <p class="mono" style="color:var(--gold);">${fmtDate(s.date_time)}</p>
        <p class="muted" style="font-size:13px;">${Object.entries(s.category_prices).map(([c,p]) => `${c}: ${fmtMoney(p)}`).join(' · ')}</p>
      </div>
      <div class="stub-stub"><span class="code">SELECT SEATS</span></div>
    </a>
  `).join('');
});

// ================= SEAT MAP / SHOW =================
route(/^#\/show\/([^?]+)(?:\?event=(.+))?$/, async (app, showId, eventId) => {
  app.innerHTML = `<div class="empty">Loading seat map…</div>`;
  let seats = await api(`/shows/${showId}/seats`);
  let selected = new Set();
  let currentHold = null;

  function categories() { return [...new Set(seats.map(s => s.category))]; }
  function seatsFor() { return seats; }

  function paint(seatsData) {
    // Reassign, don't mutate-in-place — the first call passes `seats`
    // itself as seatsData, and an in-place clear (`seats.length = 0`)
    // was wiping the very array we were about to read from.
    seats = seatsData;
    const bySection = {};
    for (const s of seats) {
      bySection[s.section] = bySection[s.section] || {};
      bySection[s.section][s.row] = bySection[s.section][s.row] || [];
      bySection[s.section][s.row].push(s);
    }
    const rowsHtml = Object.entries(bySection).map(([section, rows]) => `
      <div class="screen">${section}</div>
      ${Object.entries(rows).map(([row, rowSeats]) => `
        <div class="seat-row">
          <span class="row-label">${row}</span>
          ${rowSeats.sort((a,b)=>a.number-b.number).map(s => seatEl(s)).join('')}
        </div>
      `).join('')}
    `).join('');
    document.getElementById('seatMapHost').innerHTML = rowsHtml;
    document.querySelectorAll('.seat.available, .seat.selected').forEach(el => {
      el.addEventListener('click', () => toggleSeat(el.dataset.id));
    });
    updateHoldBar();
    updateWaitlistPrompt();
  }

  function seatEl(s) {
    const isSelected = selected.has(s.seatId);
    let cls = s.status;
    if (isSelected) cls = 'selected';
    if (s.status === 'held' && s.freeingSoon) cls += ' freeing';
    return `<button class="seat ${cls}" data-id="${s.seatId}" title="${s.category} ₹${s.price}${s.freeingSoon ? ' — may free up soon' : ''}" ${s.status !== 'available' && !isSelected ? 'disabled' : ''}>${s.number}</button>`;
  }

  function toggleSeat(id) {
    if (currentHold) return; // already holding — must release/confirm first
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    paint(seats);
  }

  function updateHoldBar() {
    const bar = document.getElementById('holdBar');
    if (!bar) return;
    if (currentHold) {
      bar.innerHTML = `
        <div>Holding ${currentHold.seatIds.length} seat(s) — <span class="timer mono" id="holdTimer"></span></div>
        <div style="display:flex; gap:10px;">
          <button class="btn" id="releaseBtn">Release</button>
          <button class="btn primary" id="confirmBtn">Confirm booking</button>
        </div>
      `;
      document.getElementById('releaseBtn').onclick = releaseHold;
      document.getElementById('confirmBtn').onclick = confirmBooking;
      tickTimer();
    } else if (selected.size) {
      const total = seats.filter(s => selected.has(s.seatId)).reduce((sum, s) => sum + s.price, 0);
      bar.innerHTML = `
        <div>${selected.size} seat(s) selected — ${fmtMoney(total)}</div>
        <button class="btn primary" id="holdBtn">Hold seats (${window.__ttl || 10} min)</button>
      `;
      document.getElementById('holdBtn').onclick = placeHold;
    } else {
      bar.innerHTML = `<div class="muted">Tap available (green) seats to select them.</div>`;
    }
  }

  let timerInterval;
  function tickTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const el = document.getElementById('holdTimer');
      if (!el || !currentHold) return clearInterval(timerInterval);
      const msLeft = new Date(currentHold.expiresAt).getTime() - Date.now();
      if (msLeft <= 0) {
        el.textContent = '00:00';
        toast('Your hold expired — seats released back to the pool.');
        currentHold = null; selected = new Set();
        clearInterval(timerInterval);
        refresh();
        return;
      }
      const m = Math.floor(msLeft / 60000), s = Math.floor((msLeft % 60000) / 1000);
      el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      el.classList.toggle('urgent', msLeft < 60000);
    }, 500);
  }

  async function placeHold() {
    try {
      const data = await api(`/shows/${showId}/hold`, { method: 'POST', body: { seatIds: [...selected] } });
      currentHold = data;
      updateHoldBar();
    } catch (e) {
      toast(e.message + (e.data && e.data.seats ? ` (${e.data.seats.join(', ')})` : ''));
      await refresh();
    }
  }
  async function releaseHold() {
    await api(`/holds/${currentHold.holdId}/release`, { method: 'POST' });
    currentHold = null; selected = new Set();
    updateHoldBar();
  }
  async function confirmBooking() {
    try {
      const result = await api(`/holds/${currentHold.holdId}/confirm`, { method: 'POST' });
      showConfirmation(result);
      currentHold = null; selected = new Set();
    } catch (e) { toast(e.message); currentHold = null; await refresh(); }
  }

  function showConfirmation(result) {
    if (result.emailPreviewUrl) {
      window.open(result.emailPreviewUrl, "_blank");
    }
    
    document.getElementById('app').innerHTML = `
      <div class="eyebrow">Booked</div>
      <h1>You're in.</h1>
      <div class="stub" style="max-width:520px;">
        <div class="stub-main">
          <p class="mono">Reference</p>
          <h2 class="mono" style="color:var(--gold);">${result.refCode}</h2>
          <p>Total paid: ${fmtMoney(result.total)}</p>
          <p class="muted">A confirmation with this QR was emailed to you.</p>
          ${result.emailPreviewUrl ? `<p class="muted" style="font-size:12px;">Dev mode — view the sent email: <a href="${result.emailPreviewUrl}" target="_blank">preview link</a></p>` : ''}
          <a class="btn" href="#/bookings" style="display:inline-block; margin-top:12px;">View my tickets</a>
        </div>
        <div class="stub-stub"><span class="code">${result.refCode}</span></div>
      </div>
      <div class="qr-box" style="max-width:260px; margin-top:20px;"><img src="${result.qrDataUrl}" width="200" height="200" alt="QR ticket"/></div>
    `;
  }

  async function updateWaitlistPrompt() {
    const host = document.getElementById('waitlistHost');
    if (!host || !state.user || state.user.role !== 'customer') { if (host) host.innerHTML=''; return; }
    const soldOutCats = categories().filter(c => seats.filter(s => s.category === c && s.status === 'available').length === 0);
    if (!soldOutCats.length) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <div class="empty" style="text-align:left;">
        <strong>Sold out:</strong> ${soldOutCats.join(', ')}. Join the waitlist and we'll email you the moment a seat frees up (auto-assigned by reliability, then by who joined first).
        <div class="form-row" style="margin-top:12px; max-width:360px;">
          <select id="wlCategory">${soldOutCats.map(c => `<option>${c}</option>`).join('')}</select>
          <button class="btn" id="wlJoin">Join waitlist</button>
        </div>
      </div>`;
    document.getElementById('wlJoin').onclick = async () => {
      try {
        const r = await api(`/shows/${showId}/waitlist`, { method: 'POST', body: { category: document.getElementById('wlCategory').value } });
        toast(`You're on the waitlist (approx. position ${r.approxPosition}).`);
      } catch (e) { toast(e.message); }
    };
  }

  async function refresh() {
    const fresh = await api(`/shows/${showId}/seats`);
    paint(fresh);
  }

  app.innerHTML = `
    <a href="${eventId ? `#/event/${eventId}` : '#/'}" class="muted" style="font-size:12px; text-decoration:none;">&larr; ${eventId ? 'Back to showtimes' : 'Browse'}</a>
    <div class="eyebrow" style="margin-top:10px;">Seat selection</div>
    <h1>Pick your seats</h1>
    <div class="legend">
      <span><i class="dot" style="background:var(--available)"></i>Available</span>
      <span><i class="dot" style="background:var(--gold)"></i>Selected by you</span>
      <span><i class="dot" style="background:var(--held)"></i>Held by someone</span>
      <span><i class="dot" style="background:var(--freeing)"></i>Held, may free up soon</span>
      <span><i class="dot" style="background:var(--booked)"></i>Booked</span>
    </div>
    <div class="seat-map" id="seatMapHost"></div>
    <div id="waitlistHost"></div>
    <div class="hold-bar" id="holdBar"></div>
  `;
  paint(seats);

  if (!state.socket) state.socket = io();
  state.socket.emit('join:show', showId);
  const onUpdate = (data) => { if (document.getElementById('seatMapHost')) paint(data); };
  state.socket.on('seats:update', onUpdate);
  const onOffer = (data) => toast(`A ${data.category} seat just opened up and was offered to ${data.customerName} from the waitlist.`);
  state.socket.on('waitlist:offer', onOffer);
  window.addEventListener('hashchange', function cleanup() {
    state.socket.emit('leave:show', showId);
    state.socket.off('seats:update', onUpdate);
    state.socket.off('waitlist:offer', onOffer);
    window.removeEventListener('hashchange', cleanup);
  }, { once: true });
});

// Waitlist offer completion — literally the same confirm flow as a normal
// hold, since an offer IS a hold under the hood.
route(/^#\/offer\/(.+)$/, async (app, holdId) => {
  const hold = await api(`/holds/${holdId}`);
  app.innerHTML = `
    <div class="eyebrow">Waitlist offer</div>
    <h1>Your seat is waiting.</h1>
    <p class="muted">This offer expires at ${fmtDate(hold.expires_at)}. Confirm now to claim it.</p>
    <button class="btn primary" id="claimBtn" style="margin-top:16px;">Confirm booking</button>
  `;
  document.getElementById('claimBtn').onclick = async () => {
    try {
      const result = await api(`/holds/${holdId}/confirm`, { method: 'POST' });
      location.hash = '#/bookings';
      toast(`Booked! Reference ${result.refCode}`);
    } catch (e) { toast(e.message); }
  };
});

// ================= BOOKINGS =================
route(/^#\/bookings$/, async (app) => {
  if (!state.user) { location.hash = '#/login'; return; }
  const bookings = await api('/bookings');
  app.innerHTML = `
    <div class="eyebrow">Your stubs</div>
    <h1>My tickets</h1>
    <div class="grid cols-2" id="list" style="margin-top:20px;"></div>
  `;
  const list = document.getElementById('list');
  if (!bookings.length) { list.innerHTML = `<div class="empty">No bookings yet. <a href="#/">Browse events</a>.</div>`; return; }
  list.innerHTML = bookings.map(b => `
    <div class="stub">
      <div class="stub-main">
        <span class="badge ${b.status === 'confirmed' ? 'movie' : 'concert'}">${b.status}</span>
        <h3 style="text-transform:none; letter-spacing:0; font-size:17px; color:var(--text); margin-top:8px;">${b.title}</h3>
        <p class="muted mono" style="font-size:12px;">${fmtDate(b.date_time)}</p>
        <p class="mono" style="color:var(--gold);">${b.ref_code}</p>
        <p>${fmtMoney(b.total_amount)} · ${b.seat_ids.length} seat(s)</p>
        ${b.status === 'confirmed' ? `<button class="btn danger small" data-id="${b.id}">Cancel booking</button>` : ''}
      </div>
      <div class="stub-stub"><span class="code">${b.ref_code}</span></div>
    </div>
  `).join('');
  list.querySelectorAll('button[data-id]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Cancel this booking? The seat(s) will be offered to the waitlist.')) return;
      await api(`/bookings/${btn.dataset.id}/cancel`, { method: 'POST' });
      toast('Booking cancelled. Seat(s) offered to the waitlist if one exists.');
      render();
    };
  });
});

// ================= ORGANISER =================
route(/^#\/organiser$/, async (app) => {
  if (!state.user || (state.user.role !== 'organiser' && state.user.role !== 'admin')) { location.hash = '#/'; return; }
  const [events, venues] = await Promise.all([api('/organiser/events'), api('/venues')]);
  app.innerHTML = `
    <div class="eyebrow">Organiser desk</div>
    <h1>Your events</h1>
    <div class="stub" style="margin:20px 0;">
      <div class="stub-main">
        <h3>Create an event</h3>
        <form id="evForm">
          <div class="form-row">
            <div class="field"><label>Title</label><input name="title" required/></div>
            <div class="field"><label>Type</label><select name="type"><option value="movie">Movie</option><option value="concert">Concert</option></select></div>
          </div>
          <div class="field"><label>Venue</label>
            <select name="venueId">${venues.map(v => `<option value="${v.id}">${v.name}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Description</label><input name="description"/></div>
          <button class="btn primary" type="submit">Create event</button>
        </form>
      </div>
      <div class="stub-stub"><span class="code">NEW LISTING</span></div>
    </div>
    <h3 class="section-gap">Existing events</h3>
    <div id="evList"></div>
  `;
  document.getElementById('evForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target).entries());
    try { await api('/events', { method: 'POST', body }); toast('Event created.'); render(); }
    catch (e) { toast(e.message); }
  };
  const evList = document.getElementById('evList');
  if (!events.length) { evList.innerHTML = `<div class="empty">No events yet — create one above.</div>`; return; }
  evList.innerHTML = events.map(e => `
    <div class="stub" style="margin-bottom:14px;">
      <div class="stub-main">
        <span class="badge ${e.type}">${e.type}</span>
        <h3 style="text-transform:none; letter-spacing:0; font-size:17px; color:var(--text); margin-top:8px;">${e.title}</h3>
        <details style="margin-top:10px;">
          <summary class="muted" style="cursor:pointer;">Add a showtime</summary>
          <form class="showForm" data-event="${e.id}" style="margin-top:10px;">
            <div class="form-row">
              <div class="field"><label>Date &amp; time</label><input name="dateTime" type="datetime-local" required/></div>
            </div>
            <div class="form-row">
              <div class="field"><label>Premium price (₹)</label><input name="premium" type="number" value="450" required/></div>
              <div class="field"><label>Standard price (₹)</label><input name="standard" type="number" value="250" required/></div>
            </div>
            <button class="btn small" type="submit">Add showtime</button>
          </form>
        </details>
        <a class="btn small" href="#/organiser/summary/${e.id}" style="display:inline-block; margin-top:8px;">View revenue &amp; bookings</a>
      </div>
      <div class="stub-stub"><span class="code">${e.type.toUpperCase()}</span></div>
    </div>
  `).join('');
  evList.querySelectorAll('.showForm').forEach(f => {
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target).entries());
      const body = { dateTime: new Date(fd.dateTime).toISOString(), categoryPrices: { Premium: Number(fd.premium), Standard: Number(fd.standard) } };
      try { await api(`/events/${f.dataset.event}/shows`, { method: 'POST', body }); toast('Showtime added.'); render(); }
      catch (e) { toast(e.message); }
    };
  });
});

route(/^#\/organiser\/summary\/(.+)$/, async (app, eventId) => {
  const summary = await api(`/organiser/events/${eventId}/summary`);
  app.innerHTML = `
    <div class="eyebrow">Revenue &amp; bookings</div>
    <h1>${summary.event.title}</h1>
    <p class="muted">Total revenue: <strong style="color:var(--gold);">${fmtMoney(summary.totalRevenue)}</strong></p>
    <table class="section-gap">
      <thead><tr><th>Show</th><th>Confirmed</th><th>Cancelled</th><th>Waitlisted</th><th>Available</th><th>Held</th><th>Booked</th><th>Revenue</th></tr></thead>
      <tbody>
        ${summary.shows.map(s => `
          <tr>
            <td class="mono">${fmtDate(s.dateTime)}</td>
            <td>${s.confirmedBookings}</td>
            <td>${s.cancelledBookings}</td>
            <td>${s.currentlyWaitlisted}</td>
            <td>${s.seatBreakdown.available || 0}</td>
            <td>${s.seatBreakdown.held || 0}</td>
            <td>${s.seatBreakdown.booked || 0}</td>
            <td>${fmtMoney(s.revenue)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <a class="btn" href="#/organiser" style="display:inline-block; margin-top:20px;">Back</a>
  `;
});

// ================= ADMIN =================
route(/^#\/admin$/, async (app) => {
  if (!state.user || state.user.role !== 'admin') { location.hash = '#/'; return; }
  app.innerHTML = `
    <div class="eyebrow">Admin</div>
    <h1>Create a venue</h1>
    <p class="muted">Define one row at a time. Add as many rows as the venue needs, then submit.</p>
    <div class="field"><label>Venue name</label><input id="vName" required/></div>
    <div class="field"><label>Address</label><input id="vAddress"/></div>
    <div id="rows"></div>
    <button class="btn" id="addRow">+ Add row</button>
    <div style="margin-top:18px;"><button class="btn primary" id="submitVenue">Create venue</button></div>
    <p class="error-text" id="vErr"></p>
  `;
  const rowsEl = document.getElementById('rows');
  function addRow() {
    const div = document.createElement('div');
    div.className = 'form-row rowDef';
    div.style.marginTop = '10px';
    div.innerHTML = `
      <div class="field"><label>Section</label><input class="section" value="Main Hall"/></div>
      <div class="field"><label>Row label</label><input class="rowLabel" value="A"/></div>
      <div class="field"><label>Seat count</label><input class="seatCount" type="number" value="10"/></div>
      <div class="field"><label>Category</label><input class="category" value="Standard"/></div>
    `;
    rowsEl.appendChild(div);
  }
  addRow(); addRow();
  document.getElementById('addRow').onclick = addRow;
  document.getElementById('submitVenue').onclick = async () => {
    const rows = [...rowsEl.querySelectorAll('.rowDef')].map(r => ({
      section: r.querySelector('.section').value,
      row_label: r.querySelector('.rowLabel').value,
      seatCount: Number(r.querySelector('.seatCount').value),
      category: r.querySelector('.category').value,
    }));
    const bySection = {};
    for (const r of rows) {
      bySection[r.section] = bySection[r.section] || [];
      bySection[r.section].push({ row_label: r.row_label, seatCount: r.seatCount, category: r.category });
    }
    const layout = Object.entries(bySection).map(([section, rows]) => ({ section, rows }));
    try {
      const res = await api('/venues', { method: 'POST', body: { name: document.getElementById('vName').value, address: document.getElementById('vAddress').value, layout } });
      toast(`Venue created with ${res.seatCount} seats.`);
      location.hash = '#/organiser';
    } catch (e) { document.getElementById('vErr').textContent = e.message; }
  };

  // ---- Stuck-hold recovery ----
  const holds = await api('/admin/holds');
  const holdsHost = document.createElement('div');
  holdsHost.className = 'section-gap';
  app.appendChild(holdsHost);
  holdsHost.innerHTML = `
    <h3>Active holds</h3>
    <p class="muted" style="font-size:13px;">Every seat currently held anywhere in the system. Overdue holds should clear automatically within a few seconds — if one lingers, release it by hand here.</p>
    <div id="holdsList" style="margin-top:12px;"></div>
  `;
  const holdsList = document.getElementById('holdsList');
  if (!holds.length) {
    holdsList.innerHTML = `<div class="empty">No active holds right now.</div>`;
  } else {
    holdsList.innerHTML = `
      <table>
        <thead><tr><th>Customer</th><th>Seats</th><th>Expires</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${holds.map(h => `
            <tr>
              <td>${h.customer_name}<br/><span class="muted mono" style="font-size:11px;">${h.customer_email}</span></td>
              <td class="mono">${h.seat_ids.length} seat(s)${h.is_waitlist_offer ? ' <span class="badge concert">offer</span>' : ''}</td>
              <td class="mono">${fmtDate(h.expires_at)}</td>
              <td>${h.overdue ? '<span style="color:var(--booked)">overdue</span>' : 'active'}</td>
              <td><button class="btn small danger" data-hold="${h.id}">Force release</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    holdsList.querySelectorAll('button[data-hold]').forEach(btn => {
      btn.onclick = async () => {
        await api(`/admin/holds/${btn.dataset.hold}/force-release`, { method: 'POST' });
        toast('Hold released.');
        render();
      };
    });
  }
});

render();
