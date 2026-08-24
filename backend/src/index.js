require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');

const socketService = require('./services/socket');
const scheduler = require('./services/scheduler');

const authRoutes = require('./routes/auth');
const venueRoutes = require('./routes/venues');
const eventRoutes = require('./routes/events');
const seatRoutes = require('./routes/seats');
const bookingRoutes = require('./routes/bookings');
const waitlistRoutes = require('./routes/waitlist');
const organiserRoutes = require('./routes/organiser');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/venues', venueRoutes);
app.use('/api/events', eventRoutes);
app.use('/api', seatRoutes);       // /api/shows/:id/seats, /api/holds/:id/*
app.use('/api/bookings', bookingRoutes);
app.use('/api', waitlistRoutes);   // /api/shows/:id/waitlist
app.use('/api/organiser', organiserRoutes);
app.use('/api/admin', adminRoutes);

// Serve the static frontend (single-service deploy: one Node process for API + UI).
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
socketService.init(server, process.env.CLIENT_ORIGIN);
scheduler.start();

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Ticketron API + frontend listening on :${PORT}`));
