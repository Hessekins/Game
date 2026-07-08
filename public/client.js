const socket = io();

let selfId = null;
let roomCode = null;
let currentLetters = [];
let submitCountdownHandle = null;
let voteCountdownHandle = null;

const views = {
  landing: document.getElementById('view-landing'),
  lobby: document.getElementById('view-lobby'),
  submitting: document.getElementById('view-submitting'),
  voting: document.getElementById('view-voting'),
  results: document.getElementById('view-results'),
  gameover: document.getElementById('view-gameover'),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

function el(id) { return document.getElementById(id); }

// ---------- Landing ----------
el('createRoomBtn').addEventListener('click', () => {
  const name = el('createName').value.trim();
  if (!name) return showLandingError('Enter a name first.');
  socket.emit('createRoom', { name });
});

el('joinRoomBtn').addEventListener('click', () => {
  const name = el('joinName').value.trim();
  const code = el('joinCode').value.trim().toUpperCase();
  if (!name) return showLandingError('Enter a name first.');
  if (!code) return showLandingError('Enter a room code.');
  socket.emit('joinRoom', { name, code });
});

function showLandingError(msg) {
  const e = el('landingError');
  e.textContent = msg;
  e.classList.remove('hidden');
}

socket.on('errorMsg', ({ message }) => {
  showLandingError(message);
  el('submitError').textContent = message;
  el('submitError').classList.remove('hidden');
  setTimeout(() => el('submitError').classList.add('hidden'), 4000);
});

socket.on('joinedRoom', ({ code, selfId: id }) => {
  selfId = id;
  roomCode = code;
  el('roomBadge').classList.remove('hidden');
  el('roomCodeLabel').textContent = code;
  el('lobbyCode').textContent = code;
  showView('lobby');
});

// ---------- Lobby / room state ----------
socket.on('roomUpdate', (state) => {
  el('scoreboard').classList.remove('hidden');
  renderScoreboard(state.players);

  if (state.phase === 'lobby') {
    renderLobby(state);
  }
  if (state.phase === 'submitting') {
    renderSubmitStatus(state.players);
  }
});

function renderLobby(state) {
  showView('lobby');
  const list = el('lobbyPlayers');
  list.innerHTML = '';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}</span> ${p.isHost ? '<span class="tag host">HOST</span>' : ''} ${!p.connected ? '<span class="tag out">offline</span>' : ''}`;
    list.appendChild(li);
  });
  const me = state.players.find((p) => p.id === selfId);
  const startBtn = el('startGameBtn');
  if (me && me.isHost) {
    startBtn.classList.remove('hidden');
    startBtn.disabled = state.players.filter((p) => p.connected).length < 2;
  } else {
    startBtn.classList.add('hidden');
  }
  el('lobbyHint').textContent =
    state.players.filter((p) => p.connected).length < 2
      ? 'Waiting for at least 2 players...'
      : (me && me.isHost ? 'Ready when you are!' : 'Waiting for host to start the game...');
}

el('startGameBtn').addEventListener('click', () => socket.emit('startGame'));

function renderScoreboard(players) {
  const list = el('scoreboardList');
  list.innerHTML = '';
  [...players]
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name}: ${p.score}`;
      list.appendChild(li);
    });
}

function renderSubmitStatus(players) {
  const list = el('submitStatusList');
  list.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    let tag = '';
    if (p.hasSubmitted) tag = '<span class="tag done">Submitted</span>';
    else if (p.isOut) tag = '<span class="tag out">Out</span>';
    else if (!p.connected) tag = '<span class="tag out">offline</span>';
    else tag = '<span class="tag">Thinking...</span>';
    li.innerHTML = `<span>${escapeHtml(p.name)}</span> ${tag}`;
    list.appendChild(li);
  });
}

// ---------- Round start (submitting) ----------
socket.on('roundStart', (data) => {
  currentLetters = data.letters;
  showView('submitting');
  el('answerInput').value = '';
  el('answerInput').disabled = false;
  el('submitAnswerBtn').disabled = false;
  el('submitStatus').textContent = '';
  el('submitError').classList.add('hidden');

  const lettersDiv = el('letters');
  lettersDiv.innerHTML = '';
  data.letters.forEach((l) => {
    const span = document.createElement('span');
    span.textContent = l;
    lettersDiv.appendChild(span);
  });

  const titleParts = data.isTiebreaker
    ? [`Tiebreaker Round`]
    : [`Round ${data.round} of ${data.totalRounds}`];
  document.querySelector('#view-submitting h2').textContent = `Make an Acronym! (${titleParts[0]})`;
  el('tiebreakerNote').classList.toggle('hidden', !data.isTiebreaker);

  const amParticipant = data.participantIds.includes(selfId);
  if (!amParticipant) {
    el('answerInput').disabled = true;
    el('submitAnswerBtn').disabled = true;
    el('submitStatus').textContent = "You're spectating this bonus round — get ready to vote!";
  }

  runCountdown(data.endsAt, data.durationSeconds, 'submitTimerFill', 'submitTimerText', () => {
    el('answerInput').disabled = true;
    el('submitAnswerBtn').disabled = true;
  });
});

el('submitAnswerBtn').addEventListener('click', () => {
  const text = el('answerInput').value;
  if (!text.trim()) return;
  socket.emit('submitAnswer', { text });
  el('submitAnswerBtn').disabled = true;
  el('answerInput').disabled = true;
  el('submitStatus').textContent = 'Answer submitted! Waiting for others...';
});

// ---------- Voting ----------
socket.on('votingStart', (data) => {
  showView('voting');
  el('voteStatus').textContent = '';
  const list = el('voteList');
  list.innerHTML = '';
  data.submissions.forEach((sub) => {
    const li = document.createElement('li');
    const textDiv = document.createElement('div');
    textDiv.className = 'vote-text';
    textDiv.textContent = sub.text;
    li.appendChild(textDiv);
    const isSelf = data.selfEntryId !== null && sub.entryId === data.selfEntryId;
    if (isSelf) {
      const badge = document.createElement('span');
      badge.className = 'tag';
      badge.textContent = 'Your answer';
      li.appendChild(badge);
    } else {
      const btn = document.createElement('button');
      btn.textContent = 'Vote for this';
      btn.addEventListener('click', () => {
        socket.emit('castVote', { entryId: sub.entryId });
        [...list.querySelectorAll('button')].forEach((b) => (b.disabled = true));
        el('voteStatus').textContent = 'Vote cast! Waiting for others...';
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  });

  if (data.submissions.length === 0) {
    list.innerHTML = '<li>No one submitted an answer this round.</li>';
  }

  runCountdown(data.endsAt, data.durationSeconds, 'voteTimerFill', 'voteTimerText', () => {
    [...list.querySelectorAll('button')].forEach((b) => (b.disabled = true));
  });
});

// ---------- Results ----------
socket.on('roundResults', (data) => {
  showView('results');
  document.getElementById('resultsTitle').textContent = data.isTiebreaker
    ? 'Tiebreaker Results'
    : `Round ${data.round} Results`;
  const list = el('resultsList');
  list.innerHTML = '';
  if (data.results.length === 0) {
    list.innerHTML = '<li>Nobody submitted an answer this round — no points awarded.</li>';
  }
  data.results.forEach((r, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="result-top"><span>#${idx + 1} ${escapeHtml(r.name)}</span><span>${r.pointsThisRound} pts (${r.votes} votes${r.bonus ? ' + 2 bonus' : ''})</span></div>
      <div class="result-detail">"${escapeHtml(r.text)}" — total score: ${r.totalScore}</div>
    `;
    list.appendChild(li);
  });
  el('nextRoundHint').textContent = `Next round starts in ${data.nextInSeconds}s...`;
});

// ---------- Game over ----------
socket.on('gameOver', (data) => {
  showView('gameover');
  el('winnerLine').textContent = data.winner
    ? `🏆 ${data.winner} wins the game!`
    : 'Game over!';
  const list = el('finalScores');
  list.innerHTML = '';
  data.finalScores.forEach((p, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="result-top"><span>#${idx + 1} ${escapeHtml(p.name)}</span><span>${p.score} pts</span></div>`;
    list.appendChild(li);
  });
});

// ---------- Chat ----------
el('chatSendBtn').addEventListener('click', sendChat);
el('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const input = el('chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { text });
  input.value = '';
}

socket.on('chatMessage', (msg) => appendChat(msg));
socket.on('chatHistory', (history) => {
  el('chatMessages').innerHTML = '';
  history.forEach(appendChat);
});

function appendChat(msg) {
  const div = document.createElement('div');
  div.className = 'msg';
  const time = new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<span class="who">${escapeHtml(msg.name)}:</span> ${escapeHtml(msg.text)} <span style="color:var(--muted);font-size:0.75rem">${time}</span>`;
  const container = el('chatMessages');
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ---------- Utility ----------
function runCountdown(endsAt, durationSeconds, fillId, textId, onDone) {
  const fill = el(fillId);
  const text = el(textId);
  clearInterval(submitCountdownHandle);
  clearInterval(voteCountdownHandle);

  function tick() {
    const remainingMs = endsAt - Date.now();
    const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
    const pct = Math.max(0, Math.min(100, (remainingMs / (durationSeconds * 1000)) * 100));
    fill.style.width = pct + '%';
    text.textContent = remaining + 's';
    if (remainingMs <= 0) {
      clearInterval(handle);
      if (onDone) onDone();
    }
  }
  const handle = setInterval(tick, 250);
  if (fillId === 'submitTimerFill') submitCountdownHandle = handle;
  else voteCountdownHandle = handle;
  tick();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
