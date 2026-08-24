// waitlistEngine.js — "Ghost Queue": waitlist join + auto-offer flow.
//
// Design idea (this is the one deliberately "different" piece of the
// system, written up in full in DESIGN.md): a plain FIFO waitlist wastes
// time-limited offers on customers who are statistically unlikely to act
// on them, which is exactly the failure mode the brief calls out
// ("last-minute cancellations go to waste"). So the queue is ranked by
// each customer's reliability_score (nudged up on confirmed bookings,
// nudged down on abandoned holds/offers — see seatEngine) with join time
// as the tiebreaker. It is FIFO among equally-reliable customers, and it
// self-corrects: a customer who converts their offer immediately climbs
// back up.
const db = require('../db');
const { id } = require('../utils/ids');
const seatEngine = require('./seatEngine');

class BadRequestError extends Error { constructor(m) { super(m); this.status = 400; } }
class ConflictError extends Error { constructor(m) { super(m); this.status = 409; } }

function joinWaitlist(showId, category, customerId) {
  // If seats are actually available in this category, there's no reason to waitlist.
  const available = db.prepare(
    `SELECT COUNT(*) c FROM show_seats WHERE show_id=? AND category=? AND status='available'`
  ).get(showId, category).c;
  if (available > 0) throw new BadRequestError(`Seats are currently available in ${category} — no need to waitlist`);

  const existing = db.prepare(
    `SELECT * FROM waitlist WHERE show_id=? AND category=? AND customer_id=? AND status IN ('waiting','offered')`
  ).get(showId, category, customerId);
  if (existing) throw new ConflictError('Already on the waitlist for this category');

  const entryId = id('wl');
  db.prepare(`INSERT INTO waitlist (id, show_id, category, customer_id, status) VALUES (?,?,?,?,'waiting')`)
    .run(entryId, showId, category, customerId);

  const position = db.prepare(`
    SELECT COUNT(*) c FROM waitlist w JOIN users u ON u.id = w.customer_id
    WHERE w.show_id=? AND w.category=? AND w.status='waiting'
      AND (u.reliability_score > (SELECT reliability_score FROM users WHERE id=?)
           OR (u.reliability_score = (SELECT reliability_score FROM users WHERE id=?) AND w.created_at <= (SELECT created_at FROM waitlist WHERE id=?)))
  `).get(showId, category, customerId, customerId, entryId).c;

  return { entryId, approxPosition: position };
}

// Picks the best candidate currently waiting for a (show, category) and
// creates a time-limited offer hold for them on the given seat. Returns
// null if nobody is waiting (caller should just release the seat normally).
const offerToNextTx = db.transaction((showId, category, showSeatId) => {
  const candidate = db.prepare(`
    SELECT w.* FROM waitlist w
    JOIN users u ON u.id = w.customer_id
    WHERE w.show_id = ? AND w.category = ? AND w.status = 'waiting'
    ORDER BY u.reliability_score DESC, w.created_at ASC
    LIMIT 1
  `).get(showId, category);
  if (!candidate) return null;

  const holdId = id('hold');
  const expiresAt = seatEngine.isoPlusSeconds(seatEngine.WAITLIST_OFFER_TTL_SECONDS);

  const updated = db.prepare(
    `UPDATE show_seats SET status='held', held_by=?, hold_id=?, hold_expires_at=? WHERE id=? AND status='available'`
  ).run(candidate.customer_id, holdId, expiresAt, showSeatId);
  if (updated.changes === 0) return null; // seat got grabbed some other way — bail cleanly

  db.prepare(`
    INSERT INTO holds (id, show_id, customer_id, seat_ids, status, expires_at, is_waitlist_offer, waitlist_entry_id)
    VALUES (?,?,?,?,'active',?,1,?)
  `).run(holdId, showId, candidate.customer_id, JSON.stringify([showSeatId]), expiresAt, candidate.id);

  db.prepare(`UPDATE waitlist SET status='offered', offer_hold_id=? WHERE id=?`).run(holdId, candidate.id);

  return { waitlistEntryId: candidate.id, customerId: candidate.customer_id, holdId, expiresAt, showSeatId };
});

function offerToNext(showId, category, showSeatId) {
  return offerToNextTx(showId, category, showSeatId);
}

// Called by the scheduler when an offer hold expires unused: penalize
// (mildly) and roll the seat to the next person in line.
function expireOffer(waitlistEntryId, customerId) {
  db.prepare(`UPDATE waitlist SET status='expired' WHERE id=?`).run(waitlistEntryId);
  db.prepare(`UPDATE users SET reliability_score = MAX(0.2, reliability_score - 0.15) WHERE id=?`).run(customerId);
}

function markBooked(waitlistEntryId) {
  db.prepare(`UPDATE waitlist SET status='booked' WHERE id=?`).run(waitlistEntryId);
}

function listForShow(showId, category) {
  return db.prepare(`
    SELECT w.id, w.category, w.status, w.created_at, u.name, u.email
    FROM waitlist w JOIN users u ON u.id = w.customer_id
    WHERE w.show_id=? AND (? IS NULL OR w.category=?)
    ORDER BY w.created_at ASC
  `).all(showId, category || null, category || null);
}

module.exports = { BadRequestError, ConflictError, joinWaitlist, offerToNext, expireOffer, markBooked, listForShow };
