// Wipes the local SQLite database file(s) so the next `npm run seed` starts
// from a clean slate. Useful after manual testing (bookings, holds, waitlist
// entries build up fast). Does NOT touch anything else — no code, no .env.
require('dotenv').config();
const fs = require('fs');

const dbFile = process.env.DB_FILE || './data/ticketron.db';
const suffixes = ['', '-wal', '-shm', '-journal'];
let removed = 0;
for (const suffix of suffixes) {
  const f = dbFile + suffix;
  if (fs.existsSync(f)) { fs.unlinkSync(f); removed++; }
}
console.log(removed ? `Wiped ${removed} database file(s).` : 'No database file found — already clean.');
console.log('Run `npm run seed` to repopulate demo data.');
