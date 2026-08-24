// seatEngine.js — the concurrency-critical core of the whole system.
//
// CONCURRENCY MODEL:
// better-sqlite3 transactions run synchronously and SQLite (WAL mode) takes
// a write lock for the duration of a write transaction, so two "simultaneous"
// hold requests for the same seat are never actually concurrent at the
// storage layer — the second one physically waits for the first transaction
// to finish, then re-reads seat status and sees 'held', not 'available'.
// This is a real, correct concurrency guarantee for a single-process
// deployment. It is NOT sufficient once you horizontally scale to multiple
// backend instances against the same DB file — see DESIGN.md for how this
// maps onto `SELECT ... FOR UPDATE` (Postgres) or a Redis distributed lock
// if this were re-platformed for that scale.
const db = require('../db');
const { id } = require('../utils/ids');

const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 600);
const WAITLIST_OFFER_TTL_SECONDS = Number(process.env.WAITLIST_OFFER_TTL_SECONDS || 900);
const RELEASE_VALVE_WINDOW_SECONDS = Number(process.env.RELEASE_VALVE_WINDOW_SECONDS || 60);

class ConflictError extends Error {
  constructor(message, seats) { super(message); this.status = 409; this.seats = seats; }
}
class NotFoundError extends Error {
  constructor(message) { super(message); this.status = 404; }
}
class BadRequestError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function nowIso() { return new Date().toISOString(); }
function isoPlusSeconds(s) { return new Date(Date.now() + s * 1000).toISOString(); }

// Full seat map for a show, annotated with the "Release Valve" signal:
// a seat that is currently held but whose hold expires within
// RELEASE_VALVE_WINDOW_SECONDS is flagged `freeingSoon: true` so the
// frontend can show it as "might free up any second" instead of a flat
// red/unavailable block. This is cosmetic on the backend but it's the
// piece that makes the system feel alive instead of just reactive.
function getSeatMap(showId) {
  const rows = db.prepare(`
    SELECT ss.id, ss.category, ss.price, ss.status, ss.hold_expires_at,
           vs.section, vs.row_label, vs.seat_number
    FROM show_seats ss
    JOIN venue_seats vs ON vs.id = ss.venue_seat_id
    WHERE ss.show_id = ?
    ORDER BY vs.section, vs.row_label, vs.seat_number
  `).all(showId);

  const cutoff = Date.now() + RELEASE_VALVE_WINDOW_SECONDS * 1000;
  return rows.map(r => ({
    seatId: r.id,
    section: r.section,
    row: r.row_label,
    number: r.seat_number,
    category: r.category,
    price: r.price,
    status: r.status,
    freeingSoon: r.status === 'held' && r.hold_expires_at && new Date(r.hold_expires_at).getTime() <= cutoff,
  }));
}

// Atomically hold a set of seats for a customer. All-or-nothing: if ANY
// requested seat is not 'available' at the moment the transaction runs,
// the whole request is rejected and nothing is held (avoids the classic
// bug where a customer gets 3 of the 4 seats they asked for).
const holdSeatsTx = db.transaction((showId, customerId, seatIds) => {
  const placeholders = seatIds.map(() => '?').join(',');
  const seats = db.prepare(
    `SELECT id, status FROM show_seats WHERE show_id = ? AND id IN (${placeholders})`
  ).all(showId, ...seatIds);

  if (seats.length !== seatIds.length) {
    throw new BadRequestError('One or more seat ids do not belong to this show');
  }
  const unavailable = seats.filter(s => s.status !== 'available').map(s => s.id);
  if (unavailable.length) {
    throw new ConflictError('Some seats are no longer available', unavailable);
  }

  const holdId = id('hold');
  const expiresAt = isoPlusSeconds(HOLD_TTL_SECONDS);

  const updateSeat = db.prepare(
    `UPDATE show_seats SET status='held', held_by=?, hold_id=?, hold_expires_at=? WHERE id=? AND status='available'`
  );
  let changed = 0;
  for (const s of seats) changed += updateSeat.run(customerId, holdId, expiresAt, s.id).changes;

  // Defensive re-check: if we didn't manage to flip every seat (a very
  // unlucky interleave within the same transaction is impossible under
  // SQLite's locking, but this guards the logic if it's ever ported to a
  // DB with weaker isolation) roll back by throwing — the whole
  // transaction reverts automatically.
  if (changed !== seats.length) {
    throw new ConflictError('Could not acquire all seats', seatIds);
  }

  db.prepare(
    `INSERT INTO holds (id, show_id, customer_id, seat_ids, status, expires_at) VALUES (?,?,?,?,'active',?)`
  ).run(holdId, showId, customerId, JSON.stringify(seatIds), expiresAt);

  return { holdId, expiresAt, seatIds };
});

function holdSeats(showId, customerId, seatIds) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) throw new BadRequestError('seatIds required');
  return holdSeatsTx(showId, customerId, seatIds);
}

// Releases whatever seats a hold currently owns back to 'available'.
// Used for: checkout abandonment (scheduler-driven), explicit cancel,
// and expired waitlist offers (see waitlistEngine).
const releaseHoldTx = db.transaction((holdId, newStatus) => {
  const hold = db.prepare(`SELECT * FROM holds WHERE id = ?`).get(holdId);
  if (!hold) return null;
  if (hold.status !== 'active') return hold; // already resolved, nothing to do

  db.prepare(
    `UPDATE show_seats SET status='available', held_by=NULL, hold_id=NULL, hold_expires_at=NULL WHERE hold_id = ?`
  ).run(holdId);
  db.prepare(`UPDATE holds SET status = ? WHERE id = ?`).run(newStatus, holdId);
  return { ...hold, status: newStatus };
});

function releaseHold(holdId, reason = 'expired') {
  return releaseHoldTx(holdId, reason);
}

// Confirms an active hold into a real booking. Fails loudly if the hold
// already expired between the customer clicking "Pay" and the request
// landing — that's the correct behaviour, not a bug: we never let a
// booking succeed on seats that may have already been reassigned.
const confirmHoldTx = db.transaction((holdId, customerId, refCode) => {
  const hold = db.prepare(`SELECT * FROM holds WHERE id = ?`).get(holdId);
  if (!hold) throw new NotFoundError('Hold not found');
  if (hold.customer_id !== customerId) throw new BadRequestError('This hold does not belong to you');
  if (hold.status !== 'active') throw new ConflictError('This hold is no longer active (expired or already used)', []);
  if (new Date(hold.expires_at).getTime() < Date.now()) {
    db.prepare(`UPDATE holds SET status='expired' WHERE id=?`).run(holdId);
    db.prepare(`UPDATE show_seats SET status='available', held_by=NULL, hold_id=NULL, hold_expires_at=NULL WHERE hold_id=?`).run(holdId);
    throw new ConflictError('Your hold expired — please reselect seats', []);
  }

  const seatIds = JSON.parse(hold.seat_ids);
  const placeholders = seatIds.map(() => '?').join(',');
  const seats = db.prepare(`SELECT id, price FROM show_seats WHERE id IN (${placeholders})`).all(...seatIds);
  const total = seats.reduce((sum, s) => sum + s.price, 0);

  db.prepare(`UPDATE show_seats SET status='booked', hold_id=NULL, hold_expires_at=NULL WHERE hold_id=?`).run(holdId);
  db.prepare(`UPDATE holds SET status='confirmed' WHERE id=?`).run(holdId);

  const bookingId = id('bkg');
  db.prepare(`
    INSERT INTO bookings (id, ref_code, show_id, customer_id, seat_ids, total_amount, status)
    VALUES (?,?,?,?,?,?,'confirmed')
  `).run(bookingId, refCode, hold.show_id, customerId, JSON.stringify(seatIds), total);

  // Reward reliable behaviour a little. This is the flip side of the
  // penalty applied on abandoned holds/offers (see waitlistEngine).
  db.prepare(`UPDATE users SET reliability_score = MIN(1.2, reliability_score + 0.05) WHERE id = ?`).run(customerId);

  return { bookingId, showId: hold.show_id, seatIds, total };
});

function confirmHold(holdId, customerId, refCode) {
  return confirmHoldTx(holdId, customerId, refCode);
}

module.exports = {
  ConflictError, NotFoundError, BadRequestError,
  getSeatMap, holdSeats, releaseHold, confirmHold,
  nowIso, isoPlusSeconds,
  HOLD_TTL_SECONDS, WAITLIST_OFFER_TTL_SECONDS, RELEASE_VALVE_WINDOW_SECONDS,
};
