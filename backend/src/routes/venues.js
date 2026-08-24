// Admin creates/manages venues + seat layout (venue_seats is the reusable master layout).
const express = require('express');
const db = require('../db');
const { id } = require('../utils/ids');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Create a venue with a seat layout.
// Body: { name, address, layout: [{ section, rows: [{ row_label, seatCount, category }] }] }
router.post('/', requireAuth('admin'), (req, res) => {
  const { name, address, layout } = req.body || {};
  if (!name || !Array.isArray(layout) || layout.length === 0) {
    return res.status(400).json({ error: 'name and non-empty layout required' });
  }
  const venueId = id('ven');
  const insertVenue = db.prepare(`INSERT INTO venues (id, name, address, created_by) VALUES (?,?,?,?)`);
  const insertSeat = db.prepare(`
    INSERT INTO venue_seats (id, venue_id, section, row_label, seat_number, category) VALUES (?,?,?,?,?,?)
  `);
  const tx = db.transaction(() => {
    insertVenue.run(venueId, name, address || '', req.user.id);
    let count = 0;
    for (const sec of layout) {
      for (const row of sec.rows) {
        for (let n = 1; n <= row.seatCount; n++) {
          insertSeat.run(id('vseat'), venueId, sec.section, row.row_label, n, row.category);
          count++;
        }
      }
    }
    return count;
  });
  const seatCount = tx();
  res.status(201).json({ venueId, seatCount });
});

router.get('/', requireAuth(), (req, res) => {
  res.json(db.prepare(`SELECT * FROM venues ORDER BY created_at DESC`).all());
});

router.get('/:id/layout', requireAuth(), (req, res) => {
  const seats = db.prepare(`SELECT * FROM venue_seats WHERE venue_id = ? ORDER BY section, row_label, seat_number`).all(req.params.id);
  res.json(seats);
});

module.exports = router;
