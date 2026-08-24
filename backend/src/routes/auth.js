const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { id } = require('../utils/ids');
const { sign } = require('../utils/token');

const router = express.Router();

router.post('/register', (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const allowedRoles = ['customer', 'organiser'];
  const finalRole = allowedRoles.includes(role) ? role : 'customer'; // admin accounts are seeded, not self-registered
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const userId = id('usr');
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)`)
    .run(userId, name, email, hash, finalRole);
  const user = { id: userId, name, email, role: finalRole };
  res.status(201).json({ token: sign(user), user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const row = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const user = { id: row.id, name: row.name, email: row.email, role: row.role };
  res.json({ token: sign(user), user });
});

module.exports = router;
