// Demo data for a working showcase: real-sounding people, three venues
// across two formats (cinema hall + concert hall), five events, and one
// show deliberately left almost sold out so the waitlist flow is
// testable within a minute of first boot. Run: npm run seed
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');
const { id } = require('./utils/ids');

function upsertUser(name, email, password, role) {
  const existing = db.prepare(`SELECT * FROM users WHERE email=?`).get(email);
  if (existing) return existing;
  const userId = id('usr');
  db.prepare(`INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)`)
    .run(userId, name, email, bcrypt.hashSync(password, 10), role);
  return { id: userId, name, email, role };
}

function upsertVenue(name, address, createdBy, rows) {
  let venue = db.prepare(`SELECT * FROM venues WHERE name=?`).get(name);
  if (venue) return venue;
  const venueId = id('ven');
  db.prepare(`INSERT INTO venues (id,name,address,created_by) VALUES (?,?,?,?)`).run(venueId, name, address, createdBy);
  const insertSeat = db.prepare(`INSERT INTO venue_seats (id,venue_id,section,row_label,seat_number,category) VALUES (?,?,?,?,?,?)`);
  for (const r of rows) {
    for (let n = 1; n <= r.count; n++) insertSeat.run(id('vseat'), venueId, r.section, r.row, n, r.category);
  }
  venue = db.prepare(`SELECT * FROM venues WHERE id=?`).get(venueId);
  console.log(`Created venue "${venue.name}" (${rows.reduce((s, r) => s + r.count, 0)} seats).`);
  return venue;
}

function upsertEvent(title, type, description, organiserId, venueId) {
  let event = db.prepare(`SELECT * FROM events WHERE title=?`).get(title);
  if (event) return event;
  const eventId = id('evt');
  db.prepare(`INSERT INTO events (id,organiser_id,title,type,description,venue_id) VALUES (?,?,?,?,?,?)`)
    .run(eventId, organiserId, title, type, description, venueId);
  return db.prepare(`SELECT * FROM events WHERE id=?`).get(eventId);
}

// Instantiates a show's seats from the venue layout. `keepOpen` optionally
// pre-books everything except the given (row,seat) pairs, to simulate a
// near-sold-out show for testing the waitlist immediately.
function upsertShow(eventId, venueId, dateTimeIso, prices, keepOpen) {
  const already = db.prepare(`SELECT id FROM shows WHERE event_id=? AND date_time=?`).get(eventId, dateTimeIso);
  if (already) return already.id;
  const showId = id('show');
  db.prepare(`INSERT INTO shows (id,event_id,date_time,category_prices) VALUES (?,?,?,?)`)
    .run(showId, eventId, dateTimeIso, JSON.stringify(prices));
  const venueSeats = db.prepare(`SELECT * FROM venue_seats WHERE venue_id=?`).all(venueId);
  const insertShowSeat = db.prepare(`INSERT INTO show_seats (id,show_id,venue_seat_id,category,price,status) VALUES (?,?,?,?,?,?)`);
  for (const vs of venueSeats) {
    let status = 'available';
    if (keepOpen) {
      const isOpen = keepOpen.some(([row, num]) => vs.row_label === row && vs.seat_number === num);
      status = isOpen ? 'available' : 'booked';
    }
    insertShowSeat.run(id('sseat'), showId, vs.id, vs.category, prices[vs.category], status);
  }
  return showId;
}

// Fixed showtimes — late September 2026, round hours only (no odd
// minute offsets), so dates read like a real listings page rather than
// "26.4 hours from whenever the seed script happened to run."
const SHOWTIME = {
  lastReel1: '2026-09-26T18:00:00.000Z',   // 6:00 PM — near sold out on purpose (waitlist demo)
  lastReel2: '2026-09-28T21:00:00.000Z',   // 9:00 PM
  marigold: '2026-09-27T19:00:00.000Z',    // 7:00 PM
  amberStatic: '2026-09-26T20:00:00.000Z', // 8:00 PM
  lowFrequency: '2026-09-29T21:00:00.000Z',// 9:00 PM
  openAir: '2026-09-30T18:00:00.000Z',     // 6:00 PM — closing weekend of September
};

// ---- People ----
const admin = upsertUser('Meera Nair', 'admin@ticketron.dev', 'admin123', 'admin');
const cinemaOrganiser = upsertUser('Arjun Rao', 'organiser@ticketron.dev', 'organiser123', 'organiser');
const musicOrganiser = upsertUser('Kavya Suresh', 'promoter@ticketron.dev', 'organiser123', 'organiser');
const ananya = upsertUser('Ananya Iyer', 'customer1@ticketron.dev', 'password123', 'customer');
const rohan = upsertUser('Rohan Verma', 'customer2@ticketron.dev', 'password123', 'customer');

// ---- Venues ----
const multiplex = upsertVenue('Meridian Multiplex — Screen 4', '14 Anna Salai, Chennai', admin.id, [
  { section: 'Main Hall', row: 'A', count: 8, category: 'Premium' },
  { section: 'Main Hall', row: 'B', count: 8, category: 'Premium' },
  { section: 'Main Hall', row: 'C', count: 10, category: 'Standard' },
  { section: 'Main Hall', row: 'D', count: 10, category: 'Standard' },
  { section: 'Main Hall', row: 'E', count: 10, category: 'Standard' },
]);

const fretboard = upsertVenue('The Fretboard', '221 Cathedral Road, Chennai', admin.id, [
  { section: 'Floor', row: 'F1', count: 12, category: 'Premium' },
  { section: 'Floor', row: 'F2', count: 12, category: 'Premium' },
  { section: 'Balcony', row: 'BAL-A', count: 14, category: 'Standard' },
  { section: 'Balcony', row: 'BAL-B', count: 14, category: 'Standard' },
]);

const millAmphitheatre = upsertVenue('Old Mill Amphitheatre', 'ECR Road, Kanchipuram', admin.id, [
  { section: 'Lawn', row: 'L1', count: 16, category: 'Standard' },
  { section: 'Lawn', row: 'L2', count: 16, category: 'Standard' },
  { section: 'Terrace', row: 'T1', count: 10, category: 'Premium' },
]);

// ---- Events + shows ----
const lastReel = upsertEvent('The Last Reel', 'movie', 'A projectionist finds an unmarked, unfinished reel among the last film prints in the building.', cinemaOrganiser.id, multiplex.id);
upsertShow(lastReel.id, multiplex.id, SHOWTIME.lastReel1, { Premium: 450, Standard: 250 }, [['E', 1], ['E', 2]]); // near sold out — waitlist demo
upsertShow(lastReel.id, multiplex.id, SHOWTIME.lastReel2, { Premium: 450, Standard: 250 }, null); // wide open second showtime

const marigold = upsertEvent('Marigold Junction', 'movie', 'A family drama about three sisters and the sale of their childhood home.', cinemaOrganiser.id, multiplex.id);
upsertShow(marigold.id, multiplex.id, SHOWTIME.marigold, { Premium: 400, Standard: 220 }, null);

const amberStatic = upsertEvent('Amber & Static', 'concert', 'Amber & Static perform their new album in full — one date only in Chennai.', musicOrganiser.id, fretboard.id);
upsertShow(amberStatic.id, fretboard.id, SHOWTIME.amberStatic, { Premium: 1200, Standard: 650 }, null);

const lowFrequency = upsertEvent('The Low Frequency Collective', 'concert', 'An ambient and electronic set, best experienced through the venue\u2019s sound system.', musicOrganiser.id, fretboard.id);
upsertShow(lowFrequency.id, fretboard.id, SHOWTIME.lowFrequency, { Premium: 900, Standard: 500 }, null);

const openAir = upsertEvent('Open Air: Radhika Menon', 'concert', 'An outdoor acoustic performance opening the amphitheatre\u2019s autumn season.', musicOrganiser.id, millAmphitheatre.id);
upsertShow(openAir.id, millAmphitheatre.id, SHOWTIME.openAir, { Premium: 1500, Standard: 700 }, null);

console.log(`\nSeeded ${db.prepare('SELECT COUNT(*) c FROM events').get().c} events across ${db.prepare('SELECT COUNT(*) c FROM venues').get().c} venues.`);
console.log('\nLogins:');
console.log('  admin@ticketron.dev / admin123        — Meera Nair (admin)');
console.log('  organiser@ticketron.dev / organiser123 — Arjun Rao, cinema (organiser)');
console.log('  promoter@ticketron.dev / organiser123  — Kavya Suresh, music (organiser)');
console.log('  customer1@ticketron.dev / password123   — Ananya Iyer (customer)');
console.log('  customer2@ticketron.dev / password123   — Rohan Verma (customer)');
console.log('\n"The Last Reel" — first showtime is down to 2 Standard seats on purpose, to demo the waitlist immediately.');
