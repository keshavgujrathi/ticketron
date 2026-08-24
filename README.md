# Ticketron — Ticket Booking Platform

A booking platform for movies and concerts: visual seat maps, concurrency-safe
seat holds with a countdown TTL, automatic release on checkout abandonment, a
reliability-ranked waitlist that auto-assigns freed seats, and QR-coded email
tickets on every confirmed booking.

The idea underneath the required feature list: a seat re-entering inventory —
from a cancellation, an abandoned checkout, or an expired waitlist offer — is
treated as the same event. All three route through one scheduler loop and one
"offer this seat to the best-ranked waiting customer, else open it to the
public" function. The brief asks for waitlist reassignment specifically on
cancellation; this closes the same gap for abandoned checkouts too, since
they waste seats the same way. Full reasoning in [`DESIGN.md`](./DESIGN.md).

---

## Stack

- **Backend**: Node.js + Express, `better-sqlite3` (file-based, no external
  DB to set up, WAL mode gives real transactional concurrency guarantees —
  see DESIGN.md), Socket.IO for live seat-map pushes, `nodemailer` +
  `qrcode` for tickets, JWT auth.
- **Frontend**: vanilla JS single-page app, hash routing, no build step,
  served as static files by the same Express process. One service to
  deploy, no separate build pipeline to configure.
- **Why not Postgres/Mongo**: this needed to clone and run in under five
  minutes with zero external accounts. A file-based DB with WAL-mode
  transactions removes that setup friction without giving up real
  concurrency safety at single-instance scale. The schema is plain SQL and
  ports to Postgres with near-zero changes (see "Scaling past one process"
  in DESIGN.md).

## Project structure

```
ticket-booking-system/
├── backend/
│   ├── src/
│   │   ├── db.js                  # schema (CREATE TABLE ...)
│   │   ├── index.js               # express app, socket.io, scheduler boot
│   │   ├── seed.js                # demo data (venues, events, shows, people)
│   │   ├── reset.js               # wipe local DB and reseed
│   │   ├── middleware/auth.js     # JWT + role guard
│   │   ├── services/
│   │   │   ├── seatEngine.js      # hold / release / confirm — concurrency core
│   │   │   ├── waitlistEngine.js  # join + reliability-ranked auto-offer
│   │   │   ├── scheduler.js       # TTL sweep + release-valve broadcast
│   │   │   ├── mailer.js          # QR generation + email
│   │   │   └── socket.js          # per-show broadcast rooms
│   │   └── routes/                # auth, venues, events, seats, bookings, waitlist, organiser, admin
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── index.html / style.css / app.js   # static SPA, no build step
└── DESIGN.md
```

## Setup

```bash
cd backend
npm install
cp .env.example .env    # defaults work as-is
npm run seed             # 3 venues, 5 events, demo people — safe to re-run
npm start                # http://localhost:4000 — serves API + frontend together
```

To wipe local test bookings and start clean, run `npm run reset` — it
deletes the local SQLite file and reseeds from scratch.

No SMTP setup is required to see the email flow. If `SMTP_HOST` is blank,
the app creates a free [Ethereal](https://ethereal.email) test inbox on
boot and logs a preview link for every email sent. Swap in real SMTP
credentials (Gmail app password, SendGrid free tier, Mailtrap, Resend) in
`.env` for production — no code changes needed.

### Demo accounts (after `npm run seed`)

The login page has one-click buttons for all five of these — no need to
type credentials to explore the different roles.

| Role      | Email                     | Password      | Name |
|-----------|---------------------------|---------------|------|
| Admin     | admin@ticketron.dev       | admin123      | Meera Nair |
| Organiser | organiser@ticketron.dev   | organiser123  | Arjun Rao (cinema) |
| Organiser | promoter@ticketron.dev    | organiser123  | Kavya Suresh (music) |
| Customer  | customer1@ticketron.dev   | password123   | Ananya Iyer |
| Customer  | customer2@ticketron.dev   | password123   | Rohan Verma |

Seed data: 3 venues (a multiplex, an indoor concert hall, an open-air
amphitheatre), 5 events (2 movies, 3 concerts), all showtimes in late
September 2026. "The Last Reel" (first showtime, Sept 26, 6:00 PM) is
pre-booked down to 2 Standard seats on purpose, so the waitlist flow is
testable within a minute: log in as Customer 1, book the last 2 seats,
log in as Customer 2, join the waitlist, then cancel Customer 1's booking
and check the console for Customer 2's offer email.

## Deploying

One service, so Render / Railway / Fly.io all work with the same config:

- **Build command**: `cd backend && npm install`
- **Start command**: `cd backend && npm start`
- **Env vars**: copy everything from `backend/.env.example`; set
  `CLIENT_ORIGIN` to the deployed URL once you have it.
- Attach a persistent disk mounted at `backend/data` so the SQLite file
  survives restarts — otherwise every deploy starts from an empty DB.

---

## Seat hold, TTL, and auto-release

Every seat's live state lives on `show_seats.status` (`available` /
`held` / `booked`). Every hold — from a normal seat selection or a
waitlist offer — is a row in `holds` with an `expires_at`.

1. `POST /api/shows/:id/hold` — the backend runs `seatEngine.holdSeats`
   inside a single DB transaction: check every requested seat is still
   `available`, flip them all to `held`, insert one `holds` row.
   All-or-nothing: if one seat in the request was already taken, the
   whole hold is rejected and nothing is partially held.
2. `HOLD_TTL_SECONDS` (default 600, configurable) starts a client-side
   countdown from the returned `expiresAt`, and is enforced server-side
   by `scheduler.js`, which sweeps expired holds every
   `SCHEDULER_INTERVAL_MS` (default 5s) and releases their seats back to
   `available`, whether or not the customer's browser is still open.
3. Every release re-broadcasts the seat map over the show's Socket.IO
   room, so every browser watching that seat map updates within one
   scheduler tick, no polling required.
4. A customer can also release early (`POST /api/holds/:id/release`)
   when backing out of checkout, which just makes the release instant
   instead of waiting for the next sweep.

## Concurrency protection

Two customers hitting "hold" on the same seat within milliseconds of each
other cannot both succeed. `better-sqlite3` transactions are synchronous,
and SQLite in WAL mode holds a write lock for the duration of a write
transaction, so the second request's read of seat status happens after
the first transaction has already committed. There's no gap between
"check status" and "set status" for another writer to slip into. See
`seatEngine.holdSeatsTx`. This is the same class of guarantee
`SELECT ... FOR UPDATE` gives in Postgres, enforced by SQLite's
engine-level locking instead of an explicit row lock. What changes at
multi-instance scale is covered in `DESIGN.md`.

## Waitlist: join, auto-assignment, time-limited offers

- `POST /api/shows/:id/waitlist` joins the queue for a category, and is
  rejected if seats are actually available in it.
- When a seat frees up — cancellation, abandoned hold, or expired offer —
  `waitlistEngine.offerToNext` ranks candidates by reliability score
  first, join time second, and creates a new `holds` row for the winner,
  flagged `is_waitlist_offer=1`, with a longer TTL
  (`WAITLIST_OFFER_TTL_SECONDS`, default 15 min). They get an email
  linking straight to that offer (`/#/offer/:holdId`).
- If they don't confirm in time, the same scheduler sweep that handles
  normal hold expiry catches it, adjusts their reliability score, and
  immediately offers the seat to the next person — same function, no
  separate "offer expired" code path.
- Reliability score starts at 1.0: `+0.05` (capped 1.2) on a confirmed
  booking, `-0.15` (floored 0.2) on an abandoned hold or unclaimed offer.
  A light nudge, not a ban — one conversion puts a customer back near the
  front of ties.

## Recovering a stuck hold

Admin accounts have a panel (`/#/admin`, bottom section) listing every
active hold system-wide, with a force-release button on each. Built after
finding a real bug during testing where holds weren't expiring on
schedule (see the datetime-comparison note in `scheduler.js`) — so an
admin has a way to clear a stuck hold by hand if the automatic sweep ever
misbehaves again.

## Database schema

See `backend/src/db.js` for the full `CREATE TABLE` statements, each
commented inline. Summary:

- `users` — role-based (`customer` / `organiser` / `admin`), carries
  `reliability_score`.
- `venues` + `venue_seats` — a venue's seat layout is defined once and
  reused by every show at that venue.
- `events` — a movie or concert listing, owned by an organiser.
- `shows` — one date/time instance of an event, with per-category pricing.
- `show_seats` — the row concurrency revolves around: one per seat per
  show, carrying live `status`, `hold_id`, `hold_expires_at`.
- `holds` — every active/expired/confirmed hold, including waitlist
  offers (same table, `is_waitlist_offer` flag).
- `bookings` — confirmed (or later cancelled) purchases, with the QR
  data URL and reference code.
- `waitlist` — one row per (show, category, customer).

## API reference

All authenticated routes take `Authorization: Bearer <jwt>`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create a customer or organiser account |
| POST | `/api/auth/login` | — | Get a JWT |
| POST | `/api/venues` | admin | Create a venue + seat layout |
| GET | `/api/venues` | any auth | List venues |
| GET | `/api/venues/:id/layout` | any auth | Raw seat layout |
| POST | `/api/events` | organiser/admin | Create an event listing |
| POST | `/api/events/:id/shows` | organiser/admin | Add a showtime + pricing |
| GET | `/api/events` | — | Browse/filter events (`?type=`, `?q=`, `?venueId=`) |
| GET | `/api/events/:id` | — | Event detail + its shows |
| GET | `/api/shows/:id/seats` | — | Live seat map |
| POST | `/api/shows/:id/hold` | customer | Hold seats — `{ seatIds: [...] }` |
| POST | `/api/holds/:id/release` | customer | Explicit early release |
| POST | `/api/holds/:id/confirm` | customer | Confirm hold → booking + QR email |
| GET | `/api/holds/:id` | any auth | Hold status (used by the offer page) |
| POST | `/api/shows/:id/waitlist` | customer | Join the waitlist for a category |
| GET | `/api/shows/:id/waitlist` | organiser/admin | View the queue |
| GET | `/api/bookings` | customer | Booking history |
| POST | `/api/bookings/:id/cancel` | customer | Cancel → triggers waitlist offer |
| GET | `/api/organiser/events` | organiser/admin | My events |
| GET | `/api/organiser/events/:id/summary` | organiser/admin | Revenue + booking summary per show |
| GET | `/api/admin/holds` | admin | Every active hold, system-wide |
| POST | `/api/admin/holds/:id/force-release` | admin | Manually clear a stuck hold |

Socket.IO events (room `show:<id>`, join via `socket.emit('join:show', id)`):
`seats:update` (full seat map), `waitlist:offer` (someone was just offered a seat).

## What I'd do next with more time

- Payment gateway integration (Stripe test mode) ahead of `confirm`.
- Postgres + `SELECT ... FOR UPDATE` for multi-instance deploys.
- Per-event configurable hold TTL (a concert door might want 5 minutes,
  a re-release-heavy indie film 15).
- Push notifications alongside email for waitlist offers.
