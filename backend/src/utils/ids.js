const { v4: uuidv4 } = require('uuid');
function id(prefix) { return `${prefix}_${uuidv4()}`; }
function refCode() {
  // Short, human-readable booking reference (what the QR encodes and what
  // the customer would read out at the counter if the QR scanner is down).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `TKT-${out}`;
}
module.exports = { id, refCode };
