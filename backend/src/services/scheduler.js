// scheduler.js — the single sweep loop that drives BOTH TTL mechanisms
// in this system: checkout-abandonment holds AND waitlist-offer holds.
// They're the same underlying row (holds.is_waitlist_offer just flags
// which kind), so one interval loop handles both instead of two parallel
// timers with duplicated expiry logic.
//
// Design note (also in DESIGN.md): a seat re-entering inventory — whether
// because a customer abandoned checkout, an offer timed out, or a
// confirmed booking was cancelled — is treated as the SAME event: "this
// seat needs to go to the waitlist before it goes back to the open
// market." The brief describes waitlist reassignment on cancellation
// specifically, but abandoned checkouts waste seats in exactly the same
// way, so we close that gap too rather than leaving it as dead inventory
// until someone happens to refresh the seat map.
const db = require('../db');
const seatEngine = require('./seatEngine');
const waitlistEngine = require('./waitlistEngine');
const mailer = require('./mailer');
const socket = require('./socket');

const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 5000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:4000';

async function routeSeatToWaitlistOrFree(showId, category, showSeatId) {
  const offer = waitlistEngine.offerToNext(showId, category, showSeatId);
  if (!offer) {
    socket.emitShow(showId, 'seats:update', seatEngine.getSeatMap(showId));
    return;
  }
  const customer = db.prepare(`SELECT name, email FROM users WHERE id=?`).get(offer.customerId);
  const show = db.prepare(`
    SELECT s.date_time, e.title FROM shows s JOIN events e ON e.id = s.event_id WHERE s.id = ?
  `).get(showId);
  const offerLink = `${CLIENT_ORIGIN}/#/offer/${offer.holdId}`;
  try {
    await mailer.sendWaitlistOffer({
      to: customer.email, name: customer.name, showTitle: show.title,
      category, expiresAt: offer.expiresAt, offerLink,
    });
  } catch (e) {
    console.error('[scheduler] Failed to send waitlist offer email:', e.message);
  }
  socket.emitShow(showId, 'seats:update', seatEngine.getSeatMap(showId));
  socket.emitShow(showId, 'waitlist:offer', { category, customerName: customer.name, expiresAt: offer.expiresAt });
}

async function sweepExpiredHolds() {
  // IMPORTANT: compare against a JS-generated ISO timestamp bound as a
  // parameter, NOT SQLite's datetime('now'). expires_at is written as
  // ISO 8601 ("2026-08-23T18:20:00.000Z"); datetime('now') returns a
  // different string format ("2026-08-23 18:41:23" — space, no ms, no Z).
  // SQLite compares TEXT columns lexicographically, and at the date/time
  // separator position ' ' (0x20) sorts below 'T' (0x54) — so
  // `expires_at < datetime('now')` was FALSE for same-day holds
  // regardless of actual time, and nothing ever expired. Binding both
  // sides in the same ISO format makes the string comparison correct
  // again (ISO 8601 sorts lexicographically = chronologically).
  const nowIso = new Date().toISOString();
  const expired = db.prepare(`SELECT * FROM holds WHERE status='active' AND expires_at < ?`).all(nowIso);
  for (const hold of expired) {
    const seatIds = JSON.parse(hold.seat_ids);
    const wasWaitlistOffer = !!hold.is_waitlist_offer;

    seatEngine.releaseHold(hold.id, 'expired');

    if (wasWaitlistOffer) {
      waitlistEngine.expireOffer(hold.waitlist_entry_id, hold.customer_id);
    }

    // Re-route every freed seat: waitlist first, open market otherwise.
    for (const seatId of seatIds) {
      const seat = db.prepare(`SELECT category FROM show_seats WHERE id=?`).get(seatId);
      if (seat) await routeSeatToWaitlistOrFree(hold.show_id, seat.category, seatId);
    }
  }
}

function tickReleaseValve() {
  // Periodic broadcast so the "freeing soon" highlight appears/disappears
  // for everyone browsing a show even without a state-changing action.
  const activeShowIds = db.prepare(`SELECT DISTINCT show_id FROM holds WHERE status='active'`).all();
  for (const { show_id } of activeShowIds) {
    socket.emitShow(show_id, 'seats:update', seatEngine.getSeatMap(show_id));
  }
}

function start() {
  setInterval(() => {
    sweepExpiredHolds().catch(e => console.error('[scheduler] sweep error:', e));
    tickReleaseValve();
  }, INTERVAL_MS);
  console.log(`[scheduler] running every ${INTERVAL_MS}ms`);
}

module.exports = { start, sweepExpiredHolds, routeSeatToWaitlistOrFree };
