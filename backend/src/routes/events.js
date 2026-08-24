const express = require('express');
const db = require('../db');
const { id } = require('../utils/ids');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Organiser creates a movie/concert listing.
router.post('/', requireAuth('organiser', 'admin'), (req, res) => {
  const { title, type, description, venueId } = req.body || {};
  if (!title || !['movie', 'concert'].includes(type) || !venueId) {
    return res.status(400).json({ error: 'title, type (movie|concert), venueId required' });
  }
  const venue = db.prepare(`SELECT id FROM venues WHERE id=?`).get(venueId);
  if (!venue) return res.status(404).json({ error: 'Venue not found' });

  const eventId = id('evt');
  db.prepare(`INSERT INTO events (id, organiser_id, title, type, description, venue_id) VALUES (?,?,?,?,?,?)`)
    .run(eventId, req.user.id, title, type, description || '', venueId);
  res.status(201).json({ eventId });
});

// Organiser adds a show (a date/time screening or performance) with per-category pricing.
// Body: { dateTime, categoryPrices: { "Premium": 500, "Standard": 250 } }
router.post('/:eventId/shows', requireAuth('organiser', 'admin'), (req, res) => {
  const { dateTime, categoryPrices } = req.body || {};
  if (!dateTime || !categoryPrices || typeof categoryPrices !== 'object') {
    return res.status(400).json({ error: 'dateTime and categoryPrices required' });
  }
  const event = db.prepare(`SELECT * FROM events WHERE id=?`).get(req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.organiser_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your event' });
  }

  const venueSeats = db.prepare(`SELECT * FROM venue_seats WHERE venue_id=?`).all(event.venue_id);
  if (venueSeats.length === 0) return res.status(400).json({ error: 'Venue has no seat layout defined' });

  const showId = id('show');
  const insertShow = db.prepare(`INSERT INTO shows (id, event_id, date_time, category_prices) VALUES (?,?,?,?)`);
  const insertShowSeat = db.prepare(`
    INSERT INTO show_seats (id, show_id, venue_seat_id, category, price, status) VALUES (?,?,?,?,?,'available')
  `);
  const tx = db.transaction(() => {
    insertShow.run(showId, req.params.eventId, dateTime, JSON.stringify(categoryPrices));
    for (const vs of venueSeats) {
      const price = categoryPrices[vs.category];
      if (price === undefined) throw new Error(`No price set for category "${vs.category}"`);
      insertShowSeat.run(id('sseat'), showId, vs.id, vs.category, price);
    }
  });
  try {
    tx();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.status(201).json({ showId, seatCount: venueSeats.length });
});

// Browse + filter events (customer-facing).
router.get('/', (req, res) => {
  const { type, q, venueId } = req.query;
  let sql = `
    SELECT e.*, v.name as venue_name,
      (SELECT MIN(date_time) FROM shows WHERE event_id = e.id) as next_show
    FROM events e JOIN venues v ON v.id = e.venue_id WHERE 1=1
  `;
  const params = [];
  if (type) { sql += ` AND e.type = ?`; params.push(type); }
  if (venueId) { sql += ` AND e.venue_id = ?`; params.push(venueId); }
  if (q) { sql += ` AND e.title LIKE ?`; params.push(`%${q}%`); }
  sql += ` ORDER BY e.created_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', (req, res) => {
  const event = db.prepare(`
    SELECT e.*, v.name as venue_name FROM events e JOIN venues v ON v.id=e.venue_id WHERE e.id=?
  `).get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  const shows = db.prepare(`SELECT * FROM shows WHERE event_id=? ORDER BY date_time ASC`).all(req.params.id);
  res.json({ ...event, shows: shows.map(s => ({ ...s, category_prices: JSON.parse(s.category_prices) })) });
});

module.exports = router;
