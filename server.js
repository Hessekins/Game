const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8420;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store: { CODE: { room object, updatedAt } }
const rooms = new Map();

// Clean up rooms that haven't been touched in 6 hours
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of rooms.entries()) {
    if (now - entry.updatedAt > MAX_AGE_MS) rooms.delete(code);
  }
}, 30 * 60 * 1000);

// Create a room. 409 if the code is already taken (client retries with a new code).
app.post('/api/room', (req, res) => {
  const { code, room } = req.body || {};
  if (!code || !room) return res.status(400).json({ error: 'code and room required' });
  if (rooms.has(code)) return res.status(409).json({ error: 'code taken' });
  rooms.set(code, { room, updatedAt: Date.now() });
  res.status(201).json({ ok: true });
});

// Fetch current room state
app.get('/api/room/:code', (req, res) => {
  const entry = rooms.get(req.params.code.toUpperCase());
  if (!entry) return res.status(404).json({ error: 'not found' });
  res.json(entry.room);
});

// Update room state (join, submit, vote, phase transitions, etc.)
app.put('/api/room/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = req.body;
  if (!room) return res.status(400).json({ error: 'room body required' });
  if (!rooms.has(code)) return res.status(404).json({ error: 'not found' });
  rooms.set(code, { room, updatedAt: Date.now() });
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`INITIALS! server listening on port ${PORT}`);
});
