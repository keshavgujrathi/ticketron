const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const scheduler = require('../services/scheduler');
const seatEngine = require('../services/seatEngine');
const socket = require('../services/socket');

const router = express.Router();

router.get('/', requireAuth('customer'), (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, s.date_time, e.title, e.type
    FROM bookings b JOIN shows s ON s.id=b.show_id JOIN events e ON e.id=s.event_id
    WHERE b.customer_id=? ORDER BY b.created_at DESC
  `).all(req.user.id);
  res.json(rows.map(r => ({ ...r, seat_ids: JSON.parse(r.seat_ids) })));
});

// Cancel a confirmed booking. This is what triggers the waitlist
// auto-assignment flow described in the brief: each freed seat is routed
// to the highest-priority waiting customer for its category (see
// scheduler.routeSeatToWaitlistOrFree / waitlistEngine's "Ghost Queue" ranking).
router.post('/:id/cancel', requireAuth('customer'), async (req, res) => {
  const booking = db.prepare(`SELECT * FROM bookings WHERE id=?`).get(req.params.id);
  if (!booking || booking.customer_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Booking already cancelled' });

  const seatIds = JSON.parse(booking.seat_ids);
  db.prepare(`UPDATE bookings SET status='cancelled', cancelled_at=datetime('now') WHERE id=?`).run(booking.id);

  for (const seatId of seatIds) {
    const seat = db.prepare(`SELECT category FROM show_seats WHERE id=?`).get(seatId);
    db.prepare(`UPDATE show_seats SET status='available', held_by=NULL, hold_id=NULL, hold_expires_at=NULL WHERE id=?`).run(seatId);
    if (seat) await scheduler.routeSeatToWaitlistOrFree(booking.show_id, seat.category, seatId);
  }

  socket.emitShow(booking.show_id, 'seats:update', seatEngine.getSeatMap(booking.show_id));
  res.json({ cancelled: true });
});

module.exports = router;
