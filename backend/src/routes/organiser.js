const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/events', requireAuth('organiser', 'admin'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM events WHERE organiser_id=? ORDER BY created_at DESC`).all(req.user.id));
});

// Booking summary + revenue per show for a given event.
router.get('/events/:eventId/summary', requireAuth('organiser', 'admin'), (req, res) => {
  const event = db.prepare(`SELECT * FROM events WHERE id=?`).get(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Not found' });
  if (event.organiser_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your event' });

  const shows = db.prepare(`SELECT * FROM shows WHERE event_id=?`).all(req.params.eventId);
  const summary = shows.map(show => {
    const seatStats = db.prepare(`
      SELECT status, COUNT(*) c FROM show_seats WHERE show_id=? GROUP BY status
    `).all(show.id);
    const revenueRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount),0) revenue, COUNT(*) bookingCount
      FROM bookings WHERE show_id=? AND status='confirmed'
    `).get(show.id);
    const cancelledRow = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE show_id=? AND status='cancelled'`).get(show.id);
    const waitlistRow = db.prepare(`SELECT COUNT(*) c FROM waitlist WHERE show_id=? AND status='waiting'`).get(show.id);
    return {
      showId: show.id,
      dateTime: show.date_time,
      seatBreakdown: Object.fromEntries(seatStats.map(s => [s.status, s.c])),
      revenue: revenueRow.revenue,
      confirmedBookings: revenueRow.bookingCount,
      cancelledBookings: cancelledRow.c,
      currentlyWaitlisted: waitlistRow.c,
    };
  });
  const totalRevenue = summary.reduce((s, r) => s + r.revenue, 0);
  res.json({ event: { id: event.id, title: event.title }, totalRevenue, shows: summary });
});

module.exports = router;
