const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name, email: user.email }, SECRET, { expiresIn: '7d' });
}
function verify(token) {
  return jwt.verify(token, SECRET);
}
module.exports = { sign, verify };
