const { verify } = require('../utils/token');
const db = require('../db');

// Verifies the JWT signature AND that the user it points to still exists.
// A JWT only proves "this was signed by us at some point" — it says
// nothing about whether the account is still there. If the database gets
// reset or reseeded (very normal during dev/demo) while a browser still
// holds an old token, every write that references that user_id as a
// foreign key would otherwise fail with a raw, unhelpful DB error. We'd
// rather fail here, once, with a message that tells the person exactly
// what happened and how to fix it.
function requireAuth(...roles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing auth token' });
    try {
      const payload = verify(token);
      const user = db.prepare(`SELECT id, name, email, role FROM users WHERE id = ?`).get(payload.id);
      if (!user) {
        return res.status(401).json({ error: 'Your session refers to an account that no longer exists in this database (likely reseeded) — please log out and log back in.' });
      }
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
      }
      req.user = user; // fresh from DB, not just the (possibly stale) token claims
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
module.exports = { requireAuth };
