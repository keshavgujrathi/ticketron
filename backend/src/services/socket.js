// Thin wrapper so route handlers can emit without importing the io instance
// directly everywhere. init() is called once from index.js.
let io = null;
function init(server, corsOrigin) {
  const { Server } = require('socket.io');
  io = new Server(server, { cors: { origin: corsOrigin || '*' } });
  io.on('connection', (socket) => {
    socket.on('join:show', (showId) => socket.join(`show:${showId}`));
    socket.on('leave:show', (showId) => socket.leave(`show:${showId}`));
  });
  return io;
}
function emitShow(showId, event, payload) {
  if (!io) return;
  io.to(`show:${showId}`).emit(event, payload);
}
module.exports = { init, emitShow };
