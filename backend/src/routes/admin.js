// Admin recovery tools — deliberately separate from the automatic
// scheduler path. If a hold ever gets stuck (a bug like the datetime
// format mismatch this app shipped with once, a crashed scheduler, a
// manual DB edit), an admin needs a way to see and clear it without
// touching the database directly.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const seatEngine = require('../services/seatEngine');
const socket = require('../services/socket');

const router = express.Router();

router.get('/holds', requireAuth('admin'), (req, res) => {
  const holds = db.prepare(`
    SELECT h.*, u.name as customer_name, u.email as customer_email
    FROM holds h JOIN users u ON u.id = h.customer_id
    WHERE h.status = 'active'
    ORDER BY h.expires_at ASC
  `).all();
  const now = Date.now();
  res.json(holds.map(h => ({
    ...h,
    seat_ids: JSON.parse(h.seat_ids),
    overdue: new Date(h.expires_at).getTime() < now,
  })));
});

router.post('/holds/:id/force-release', requireAuth('admin'), (req, res) => {
  const hold = db.prepare(`SELECT * FROM holds WHERE id = ?`).get(req.params.id);
  if (!hold) return res.status(404).json({ error: 'Hold not found' });
  seatEngine.releaseHold(hold.id, 'cancelled');
  socket.emitShow(hold.show_id, 'seats:update', seatEngine.getSeatMap(hold.show_id));
  res.json({ released: true });
});

module.exports = router;
