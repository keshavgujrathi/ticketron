const express = require('express');
const { requireAuth } = require('../middleware/auth');
const waitlistEngine = require('../services/waitlistEngine');

const router = express.Router();

router.post('/shows/:showId/waitlist', requireAuth('customer'), (req, res) => {
  const { category } = req.body || {};
  if (!category) return res.status(400).json({ error: 'category required' });
  try {
    const result = waitlistEngine.joinWaitlist(req.params.showId, category, req.user.id);
    res.status(201).json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/shows/:showId/waitlist', requireAuth('organiser', 'admin'), (req, res) => {
  res.json(waitlistEngine.listForShow(req.params.showId, req.query.category));
});

module.exports = router;
