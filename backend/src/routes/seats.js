const express = require('express');
const db = require('../db');
const { refCode } = require('../utils/ids');
const { requireAuth } = require('../middleware/auth');
const seatEngine = require('../services/seatEngine');
const waitlistEngine = require('../services/waitlistEngine');
const mailer = require('../services/mailer');
const socket = require('../services/socket');
const scheduler = require('../services/scheduler');

const router = express.Router();

function sendError(res, e) {
  if (e.status) return res.status(e.status).json({ error: e.message, seats: e.seats });
  console.error(e);
  // Surface the real message rather than a flat "Internal error" — this is
  // a dev/demo app, and a vague 500 just sends the person back here asking
  // what broke instead of reading it off the response themselves.
  return res.status(500).json({ error: e.message || 'Internal error' });
}

// Real-time-ish seat map (also pushed over the show:{id} socket room on any change).
router.get('/shows/:showId/seats', (req, res) => {
  res.json(seatEngine.getSeatMap(req.params.showId));
});

// Place a hold on 1+ seats. Concurrency-safe: see seatEngine.holdSeats.
router.post('/shows/:showId/hold', requireAuth('customer'), (req, res) => {
  try {
    const result = seatEngine.holdSeats(req.params.showId, req.user.id, req.body.seatIds || []);
    socket.emitShow(req.params.showId, 'seats:update', seatEngine.getSeatMap(req.params.showId));
    res.status(201).json(result);
  } catch (e) { sendError(res, e); }
});

// Explicit release (e.g. user clicks "cancel checkout" or navigates away and
// the frontend fires this via beforeunload). Abandonment WITHOUT this call
// is still caught by the scheduler's TTL sweep — this just makes it instant.
router.post('/holds/:holdId/release', requireAuth('customer'), (req, res) => {
  const hold = db.prepare(`SELECT * FROM holds WHERE id=?`).get(req.params.holdId);
  if (!hold || hold.customer_id !== req.user.id) return res.status(404).json({ error: 'Hold not found' });
  seatEngine.releaseHold(req.params.holdId, 'cancelled');
  socket.emitShow(hold.show_id, 'seats:update', seatEngine.getSeatMap(hold.show_id));
  res.json({ released: true });
});

router.get('/holds/:holdId', requireAuth(), (req, res) => {
  const hold = db.prepare(`SELECT * FROM holds WHERE id=?`).get(req.params.holdId);
  if (!hold) return res.status(404).json({ error: 'Not found' });
  res.json({ ...hold, seat_ids: JSON.parse(hold.seat_ids) });
});

// Confirm a hold into a booking: generates the QR (encoding the booking
// reference), emails it, and frees up the hold. Works identically whether
// the hold came from a normal seat selection OR a waitlist offer — an
// offer IS a hold, just one flagged is_waitlist_offer.
router.post('/holds/:holdId/confirm', requireAuth('customer'), async (req, res) => {
  try {
    const code = refCode();
    const result = seatEngine.confirmHold(req.params.holdId, req.user.id, code);

    const holdRow = db.prepare(`SELECT is_waitlist_offer, waitlist_entry_id FROM holds WHERE id=?`).get(req.params.holdId);
    if (holdRow && holdRow.is_waitlist_offer) waitlistEngine.markBooked(holdRow.waitlist_entry_id);

    const show = db.prepare(`
      SELECT s.date_time, e.title FROM shows s JOIN events e ON e.id = s.event_id WHERE s.id=?
    `).get(result.showId);
    const seatRows = db.prepare(`
      SELECT ss.category, vs.section, vs.row_label as row, vs.seat_number as number
      FROM show_seats ss JOIN venue_seats vs ON vs.id = ss.venue_seat_id
      WHERE ss.id IN (${result.seatIds.map(() => '?').join(',')})
    `).all(...result.seatIds);

    const qrDataUrl = await mailer.generateQrDataUrl(code);
    db.prepare(`UPDATE bookings SET qr_data_url=? WHERE id=?`).run(qrDataUrl, result.bookingId);

    let mailResult = { previewUrl: null };
    try {
      mailResult = await mailer.sendBookingConfirmation({
        to: req.user.email, name: req.user.name, refCode: code,
        showTitle: show.title, dateTime: show.date_time,
        seats: seatRows, total: result.total, qrDataUrl,
      });
    } catch (e) { console.error('[mailer] send failed:', e.message); }

    socket.emitShow(result.showId, 'seats:update', seatEngine.getSeatMap(result.showId));
    res.status(201).json({
      bookingId: result.bookingId, refCode: code, total: result.total,
      qrDataUrl, emailPreviewUrl: mailResult.previewUrl,
    });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
