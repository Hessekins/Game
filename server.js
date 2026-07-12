const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Game constants ----------
const SUBMIT_SECONDS = 60;
const VOTE_SECONDS = 30;
const RESULTS_SECONDS = 12;
const TOTAL_ROUNDS = 3;
const MIN_PLAYERS = 2;
const MAX_CHAT_HISTORY = 100;
const MAX_PLAYERS_MIN = 3;
const MAX_PLAYERS_MAX = 8;
const DEFAULT_MAX_PLAYERS = 4;

// Weighted letter pool (roughly English letter frequency) so rounds stay playable.
const LETTER_POOL =
  'EEEEEEEEEEEEAAAAAAAAARRRRRRRRIIIIIIIIOOOOOOOOTTTTTTTNNNNNNNSSSSSSLLLLLCCCCUUUUDDDDPPPPMMMMHHHHGGBBFFYYWWKVXZJQ';

function randomLetter() {
  return LETTER_POOL[Math.floor(Math.random() * LETTER_POOL.length)];
}

function generateLetters() {
  const count = 3 + Math.floor(Math.random() * 3); // 3, 4, or 5 letters
  const letters = [];
  for (let i = 0; i < count; i++) letters.push(randomLetter());
  return letters;
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

// ---------- Room state ----------
// rooms: code -> room object
const rooms = new Map();

// Global lobby chat (separate from in-game room chat)
const lobbyChat = [];

function createRoom(hostSocketId, hostName, { maxPlayers = DEFAULT_MAX_PLAYERS, isPrivate = false } = {}) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    players: new Map(), // id -> { id, name, score, connected, isHost }
    spectators: new Set(), // socketIds of players who joined after game started
    phase: 'lobby', // lobby | submitting | voting | results | gameover
    round: 0, // 1..TOTAL_ROUNDS, or tiebreaker round number
    isTiebreaker: false,
    tiebreakIds: [], // player ids competing in current tiebreaker round
    letters: [],
    participantIds: [], // players eligible to submit this round
    outIds: new Set(), // participants who timed out this round
    submissions: new Map(), // playerId -> text
    votes: new Map(), // voterId -> targetPlayerId
    anonOrder: [], // shuffled list of playerIds with submissions, for voting display
    timer: null,
    timerEndsAt: null,
    roomChat: [], // in-game chat (separate from global lobbyChat)
    maxPlayers: Math.max(MAX_PLAYERS_MIN, Math.min(MAX_PLAYERS_MAX, maxPlayers)),
    isPrivate,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, socketId, name) {
  const isHost = room.players.size === 0;
  room.players.set(socketId, {
    id: socketId,
    name: name.slice(0, 20),
    score: 0,
    connected: true,
    isHost,
  });
  if (isHost) room.hostId = socketId;
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
    room.timerEndsAt = null;
  }
}

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected);
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: p.connected,
    isHost: p.id === room.hostId,
    isOut: room.outIds.has(p.id),
    hasSubmitted: room.submissions.has(p.id),
    hasVoted: room.votes.has(p.id),
  }));
}

function roomStateForClients(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    isTiebreaker: room.isTiebreaker,
    players: publicPlayers(room),
    timerEndsAt: room.timerEndsAt,
    maxPlayers: room.maxPlayers,
    isPrivate: room.isPrivate,
    spectatorCount: room.spectators.size,
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit('roomUpdate', roomStateForClients(room));
}

function sendError(socket, message) {
  socket.emit('errorMsg', { message });
}

// ---------- Acronym validation ----------
function validateAnswer(text, letters) {
  if (typeof text !== 'string') return { ok: false, reason: 'Invalid answer.' };
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length !== letters.length) {
    return {
      ok: false,
      reason: `Answer must have exactly ${letters.length} word(s), one per letter.`,
    };
  }
  for (let i = 0; i < letters.length; i++) {
    const word = words[i];
    const firstAlpha = (word.match(/[A-Za-z]/) || [])[0];
    if (!firstAlpha || firstAlpha.toUpperCase() !== letters[i].toUpperCase()) {
      return {
        ok: false,
        reason: `Word ${i + 1} must start with the letter "${letters[i]}".`,
      };
    }
  }
  return { ok: true };
}

// ---------- Game flow ----------
function startGame(room) {
  if (connectedPlayers(room).length < MIN_PLAYERS) return;
  room.round = 0;
  for (const p of room.players.values()) p.score = 0;
  nextNormalRound(room);
}

function nextNormalRound(room) {
  room.round += 1;
  room.isTiebreaker = false;
  room.tiebreakIds = [];
  startRoundCommon(
    room,
    connectedPlayers(room).map((p) => p.id)
  );
}

function startTiebreakRound(room, tiedIds) {
  room.isTiebreaker = true;
  room.tiebreakIds = tiedIds;
  startRoundCommon(room, tiedIds);
}

function startRoundCommon(room, participantIds) {
  clearTimer(room);
  room.phase = 'submitting';
  room.letters = generateLetters();
  room.participantIds = participantIds;
  room.outIds = new Set();
  room.submissions = new Map();
  room.votes = new Map();
  room.anonOrder = [];
  room.timerEndsAt = Date.now() + SUBMIT_SECONDS * 1000;

  io.to(room.code).emit('roundStart', {
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    isTiebreaker: room.isTiebreaker,
    letters: room.letters,
    participantIds: room.participantIds,
    endsAt: room.timerEndsAt,
    durationSeconds: SUBMIT_SECONDS,
  });
  broadcastRoomState(room);

  room.timer = setTimeout(() => endSubmitPhase(room), SUBMIT_SECONDS * 1000);
}

function checkAllSubmitted(room) {
  if (room.phase !== 'submitting') return;
  const allDone = room.participantIds.every(
    (id) => room.submissions.has(id) || !room.players.get(id)?.connected
  );
  if (allDone) endSubmitPhase(room);
}

function endSubmitPhase(room) {
  if (room.phase !== 'submitting') return;
  clearTimer(room);
  for (const id of room.participantIds) {
    if (!room.submissions.has(id)) room.outIds.add(id);
  }
  startVotingPhase(room);
}

function startVotingPhase(room) {
  room.phase = 'voting';
  room.anonOrder = [...room.submissions.keys()];
  // shuffle
  for (let i = room.anonOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.anonOrder[i], room.anonOrder[j]] = [room.anonOrder[j], room.anonOrder[i]];
  }
  room.timerEndsAt = Date.now() + VOTE_SECONDS * 1000;

  const submissionsForVoting = room.anonOrder.map((playerId, idx) => ({
    entryId: idx,
    text: room.submissions.get(playerId),
  }));

  for (const player of connectedPlayers(room)) {
    const selfEntryId = room.anonOrder.indexOf(player.id);
    io.to(player.id).emit('votingStart', {
      submissions: submissionsForVoting,
      endsAt: room.timerEndsAt,
      durationSeconds: VOTE_SECONDS,
      selfEntryId: selfEntryId >= 0 ? selfEntryId : null,
    });
  }
  broadcastRoomState(room);

  room.timer = setTimeout(() => endVotingPhase(room), VOTE_SECONDS * 1000);
}

function eligibleVoters(room) {
  // Everyone connected can vote, including players who were out this round.
  return connectedPlayers(room).map((p) => p.id);
}

function checkAllVoted(room) {
  if (room.phase !== 'voting') return;
  const voters = eligibleVoters(room);
  const allDone = voters.every((id) => {
    const authorEntry = room.anonOrder.indexOf(id);
    // A player who has no submission (or whose only possible vote target is themselves)
    // must still cast a vote if there's more than one thing to vote on.
    return room.votes.has(id) || room.anonOrder.length - (authorEntry >= 0 ? 1 : 0) <= 0;
  });
  if (allDone) endVotingPhase(room);
}

function endVotingPhase(room) {
  if (room.phase !== 'voting') return;
  clearTimer(room);

  const voteCounts = new Map(); // playerId -> count
  for (const id of room.anonOrder) voteCounts.set(id, 0);
  for (const targetId of room.votes.values()) {
    if (voteCounts.has(targetId)) voteCounts.set(targetId, voteCounts.get(targetId) + 1);
  }

  let maxVotes = 0;
  for (const c of voteCounts.values()) maxVotes = Math.max(maxVotes, c);

  const results = room.anonOrder.map((playerId) => {
    const votes = voteCounts.get(playerId) || 0;
    const bonus = maxVotes > 0 && votes === maxVotes ? 2 : 0;
    const pointsThisRound = votes + bonus;
    const player = room.players.get(playerId);
    if (player) player.score += pointsThisRound;
    return {
      playerId,
      name: player ? player.name : 'Unknown',
      text: room.submissions.get(playerId),
      votes,
      bonus,
      pointsThisRound,
      totalScore: player ? player.score : 0,
    };
  }).sort((a, b) => b.pointsThisRound - a.pointsThisRound);

  room.phase = 'results';
  room.timerEndsAt = Date.now() + RESULTS_SECONDS * 1000;

  io.to(room.code).emit('roundResults', {
    round: room.round,
    isTiebreaker: room.isTiebreaker,
    results,
    outPlayerIds: [...room.outIds],
    nextInSeconds: RESULTS_SECONDS,
    endsAt: room.timerEndsAt,
  });
  broadcastRoomState(room);

  room.timer = setTimeout(() => advanceAfterResults(room), RESULTS_SECONDS * 1000);
}

function advanceAfterResults(room) {
  clearTimer(room);

  if (room.isTiebreaker) {
    // Determine winner among tiebreak participants only.
    const contenders = room.tiebreakIds
      .map((id) => room.players.get(id))
      .filter(Boolean);
    const top = Math.max(...contenders.map((p) => p.score));
    const stillTied = contenders.filter((p) => p.score === top).map((p) => p.id);
    if (stillTied.length <= 1) {
      endGame(room, stillTied[0] || null);
    } else {
      startTiebreakRound(room, stillTied);
    }
    return;
  }

  if (room.round >= TOTAL_ROUNDS) {
    const players = connectedPlayers(room).length
      ? [...room.players.values()]
      : [...room.players.values()];
    const top = Math.max(...players.map((p) => p.score));
    const tied = players.filter((p) => p.score === top).map((p) => p.id);
    if (tied.length > 1 && players.length > tied.length) {
      // Other non-tied players remain to vote on the bonus round.
      startTiebreakRound(room, tied);
    } else if (tied.length > 1) {
      // Everyone is tied with no outside voters; tied players vote on each other.
      startTiebreakRound(room, tied);
    } else {
      endGame(room, tied[0]);
    }
    return;
  }

  nextNormalRound(room);
}

function endGame(room, winnerId) {
  room.phase = 'gameover';
  clearTimer(room);
  const finalScores = [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
  io.to(room.code).emit('gameOver', {
    finalScores,
    winner: winnerId ? room.players.get(winnerId)?.name : null,
  });
  broadcastRoomState(room);
}

function pushChat(room, entry) {
  room.roomChat.push(entry);
  if (room.roomChat.length > MAX_CHAT_HISTORY) room.roomChat.shift();
  io.to(room.code).emit('chatMessage', entry);
}

function pushLobbyChat(entry) {
  lobbyChat.push(entry);
  if (lobbyChat.length > MAX_CHAT_HISTORY) lobbyChat.shift();
  io.emit('lobbyChatMessage', entry);
}

function reassignHostIfNeeded(room) {
  if (room.players.get(room.hostId)?.connected) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, maxPlayers, isPrivate }) => {
    if (!name || typeof name !== 'string' || !name.trim()) {
      return sendError(socket, 'Please enter a name.');
    }
    const room = createRoom(socket.id, name, { maxPlayers, isPrivate });
    addPlayer(room, socket.id, name);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('joinedRoom', { code: room.code, selfId: socket.id });
    broadcastRoomState(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    if (!name || typeof name !== 'string' || !name.trim()) {
      return sendError(socket, 'Please enter a name.');
    }
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return sendError(socket, 'Room not found.');
    if (room.isPrivate && room.phase !== 'lobby') {
      return sendError(socket, 'That game is private and has already started.');
    }

    // Can only join as regular player if in lobby and not full
    if (room.phase === 'lobby') {
      if (room.players.size >= room.maxPlayers) {
        return sendError(socket, 'Game is full.');
      }
      addPlayer(room, socket.id, name);
    } else {
      // Game already started - join as spectator
      if (room.isPrivate) {
        return sendError(socket, 'Cannot join private game after it has started.');
      }
      addPlayer(room, socket.id, name);
      room.spectators.add(socket.id);
    }

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('joinedRoom', { code: room.code, selfId: socket.id });
    socket.emit('chatHistory', room.roomChat);
    broadcastRoomState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return sendError(socket, 'Only the host can start the game.');
    if (connectedPlayers(room).length < MIN_PLAYERS) {
      return sendError(socket, `Need at least ${MIN_PLAYERS} players to start.`);
    }
    startGame(room);
  });

  socket.on('submitAnswer', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'submitting') return;
    if (!room.participantIds.includes(socket.id)) return;
    if (room.submissions.has(socket.id)) return;
    const check = validateAnswer(text, room.letters);
    if (!check.ok) return sendError(socket, check.reason);
    room.submissions.set(socket.id, text.trim());
    broadcastRoomState(room);
    checkAllSubmitted(room);
  });

  socket.on('castVote', ({ entryId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'voting') return;
    if (!room.players.get(socket.id)?.connected) return;
    if (room.votes.has(socket.id)) return;
    const targetId = room.anonOrder[entryId];
    if (!targetId) return;
    if (targetId === socket.id) return sendError(socket, "You can't vote for your own answer.");
    room.votes.set(socket.id, targetId);
    broadcastRoomState(room);
    checkAllVoted(room);
  });

  socket.on('getBrowsableRooms', () => {
    const browsableRooms = [];
    for (const room of rooms.values()) {
      if (room.isPrivate) continue; // Skip private rooms
      if (room.phase !== 'lobby') continue; // Only show waiting rooms
      if (room.players.size >= room.maxPlayers) continue; // Skip full rooms

      const hostName = room.players.get(room.hostId)?.name || 'Unknown';
      browsableRooms.push({
        code: room.code,
        hostName,
        playerCount: room.players.size,
        maxPlayers: room.maxPlayers,
        createdAt: room.createdAt,
      });
    }
    // Sort by newest first
    browsableRooms.sort((a, b) => b.createdAt - a.createdAt);
    socket.emit('roomsList', browsableRooms);
  });

  socket.on('updateRoomSettings', ({ maxPlayers, isPrivate }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return sendError(socket, 'Only the host can change settings.');
    if (room.phase !== 'lobby') return sendError(socket, 'Cannot change settings after game starts.');

    if (maxPlayers !== undefined) {
      room.maxPlayers = Math.max(MAX_PLAYERS_MIN, Math.min(MAX_PLAYERS_MAX, maxPlayers));
      // If max decreased below current players, keep them but prevent new joins
      if (room.players.size > room.maxPlayers) {
        return sendError(socket, 'Max players cannot be less than current player count.');
      }
    }
    if (isPrivate !== undefined) {
      room.isPrivate = Boolean(isPrivate);
    }
    broadcastRoomState(room);
  });

  socket.on('lobbyChat', ({ text }) => {
    if (!text || !text.trim()) return;
    // Anyone can chat in lobby
    // Find player name from any room they're in
    let playerName = 'Guest';
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        playerName = room.players.get(socket.id).name;
        break;
      }
    }
    pushLobbyChat({
      name: playerName,
      text: text.trim().slice(0, 300),
      time: Date.now(),
    });
  });

  socket.on('chatMessage', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !text || !text.trim()) return;

    // Only allow chat if in game or spectating
    if (room.phase === 'lobby') return; // Lobby chat uses separate lobbyChat event

    pushChat(room, {
      name: player.name,
      text: text.trim().slice(0, 300),
      time: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.connected = false;
    room.spectators.delete(socket.id); // Remove from spectators if was one
    reassignHostIfNeeded(room);

    if (room.phase === 'submitting') checkAllSubmitted(room);
    if (room.phase === 'voting') checkAllVoted(room);

    broadcastRoomState(room);

    if (connectedPlayers(room).length === 0) {
      clearTimer(room);
      rooms.delete(room.code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Acronym Showdown listening on port ${PORT}`);
});
