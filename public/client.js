const socket = io();

let player = null;
let playerReady = false;
let currentState = { queue: [], currentIndex: -1, isPlaying: false, seekTime: 0, lastUpdate: Date.now(), autoplay: true };
let currentPlaylist = [];
let applyingRemoteState = false; // guard so our own player events don't re-broadcast
let seekBarDragging = false;
let myName = '';

// ---------- Toast ----------
let toastTimeout = null;
function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'visible ' + type;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { el.className = ''; }, 2500);
}

// ---------- Name gate ----------
const nameGate = document.getElementById('nameGate');
const nameInput = document.getElementById('nameInput');
document.getElementById('nameSubmit').onclick = joinApp;
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinApp(); });

function joinApp() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  myName = name;
  socket.emit('identify', name);
  document.body.classList.add('app-visible');
}

// ---------- Presence ----------
const presenceEl = document.getElementById('presence');
let others = new Map();
socket.on('presence', ({ id, name, event }) => {
  if (event === 'join') others.set(id, name);
  else others.delete(id);
  presenceEl.textContent = others.size ? `with ${[...others.values()].join(', ')}` : '';
});

// ---------- YouTube IFrame API ----------
function onYouTubeIframeAPIReady() {
  player = new YT.Player('ytplayer', {
    height: '100%',
    width: '100%',
    playerVars: { autoplay: 0, controls: 1, rel: 0 },
    events: {
      onReady: () => { playerReady = true; applyState(currentState); },
      onStateChange: onPlayerStateChange,
    },
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function onPlayerStateChange(e) {
  if (applyingRemoteState) return; // ignore programmatic changes
  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit('play', player.getCurrentTime());
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit('pause', player.getCurrentTime());
  } else if (e.data === YT.PlayerState.ENDED) {
    // Auto-play: if enabled, go next; otherwise just stop
    if (currentState.autoplay) {
      socket.emit('track:next');
    }
  }
}

// ---------- Helpers ----------
function extractVideoId(input) {
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input; // bare ID
  try {
    const url = new URL(input);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1);
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2];
  } catch (_) {}
  return null;
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Fetch YouTube title via oEmbed (non-blocking)
function fetchTitle(id) {
  const fallback = `youtube.com/watch?v=${id}`;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1500));
  return Promise.race([
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null),
    timeout,
  ]).then((data) => (data && data.title) ? data.title : fallback);
}

// ---------- Applying incoming state ----------
function applyState(state) {
  currentState = state;
  renderQueue();
  renderPlaylist();
  updateAutoplayBtn();

  const track = state.queue[state.currentIndex];
  const npEl = document.getElementById('nowplaying');
  const npSub = document.getElementById('nowplaying-sub');
  if (!track) {
    npEl.textContent = 'Nothing queued yet';
    npSub.textContent = 'Paste a YouTube link below to get started';
    return;
  }
  npEl.textContent = track.title;
  npSub.textContent = `added by ${track.addedBy}`;

  if (!playerReady) return;

  applyingRemoteState = true;

  const loadedId = player.getVideoData ? player.getVideoData().video_id : null;
  const targetTime = state.isPlaying
    ? state.seekTime + (Date.now() - state.lastUpdate) / 1000
    : state.seekTime;

  if (loadedId !== track.id) {
    if (state.isPlaying) {
      player.loadVideoById(track.id, targetTime);
    } else {
      player.cueVideoById(track.id, targetTime);
    }
  } else {
    const drift = Math.abs(player.getCurrentTime() - targetTime);
    if (drift > 1.5) player.seekTo(targetTime, true);
    if (state.isPlaying) player.playVideo(); else player.pauseVideo();
  }

  setTimeout(() => { applyingRemoteState = false; }, 400);
}

socket.on('state', applyState);

// ---------- Queue UI ----------
function renderQueue() {
  const ul = document.getElementById('queue');
  const empty = document.getElementById('emptyQueue');
  ul.innerHTML = '';
  if (!currentState.queue.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  currentState.queue.forEach((track, i) => {
    const li = document.createElement('li');
    if (i === currentState.currentIndex) li.classList.add('active');
    const alreadySaved = currentPlaylist.some((p) => p.id === track.id);
    li.innerHTML = `
      <span class="idx">${i + 1}</span>
      <span class="title">${escapeHtml(track.title)}</span>
      <span class="added">${escapeHtml(track.addedBy)}</span>
      <span class="actions">
        <button class="save-to-pl" title="${alreadySaved ? 'Already in playlist' : 'Save to Playlist'}" ${alreadySaved ? 'disabled' : ''}>${alreadySaved ? '✓ Saved' : '💾 Save'}</button>
        <button class="remove-q" title="Remove from Queue">✕</button>
      </span>
    `;
    li.querySelector('.title').onclick = () => socket.emit('track:select', i);
    li.querySelector('.save-to-pl').onclick = (ev) => {
      ev.stopPropagation();
      if (!alreadySaved) socket.emit('queue:saveToPlaylist', i);
    };
    li.querySelector('.remove-q').onclick = (ev) => { ev.stopPropagation(); socket.emit('queue:remove', i); };
    ul.appendChild(li);
  });
}

// ---------- Playlist UI ----------
function renderPlaylist() {
  const ul = document.getElementById('playlist');
  const empty = document.getElementById('emptyPlaylist');
  const countEl = document.getElementById('playlistCount');
  ul.innerHTML = '';
  countEl.textContent = currentPlaylist.length ? `(${currentPlaylist.length})` : '';

  if (!currentPlaylist.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  currentPlaylist.forEach((track, i) => {
    const li = document.createElement('li');
    // Highlight if this song is currently playing in queue
    const qIdx = currentState.queue.findIndex((q) => q.id === track.id);
    if (qIdx >= 0 && qIdx === currentState.currentIndex) li.classList.add('active');
    const inQueue = qIdx >= 0;
    li.innerHTML = `
      <span class="idx">${i + 1}</span>
      <span class="title" title="Click to play">${escapeHtml(track.title)}</span>
      <span class="added">${escapeHtml(track.addedBy)}</span>
      <span class="actions">
        <button class="add-to-q" title="${inQueue ? 'Already in queue' : 'Add to Queue'}" ${inQueue ? 'disabled' : ''}>${inQueue ? '✓ Queued' : '+ Queue'}</button>
        <button class="remove-pl" title="Remove from Playlist">✕</button>
      </span>
    `;
    li.querySelector('.title').onclick = () => socket.emit('playlist:play', i);
    li.querySelector('.add-to-q').onclick = (ev) => {
      ev.stopPropagation();
      if (!inQueue) socket.emit('playlist:addToQueue', i);
    };
    li.querySelector('.remove-pl').onclick = (ev) => {
      ev.stopPropagation();
      socket.emit('playlist:remove', i);
    };
    ul.appendChild(li);
  });
}

socket.on('playlist:state', (pl) => {
  currentPlaylist = pl;
  renderPlaylist();
  renderQueue(); // refresh queue '✓ Saved' badges
});

socket.on('playlist:duplicate', ({ title }) => {
  showToast(`"${title}" is already in your playlist`, 'warn');
});

socket.on('queue:duplicate', ({ title }) => {
  showToast(`"${title}" is already in the queue`, 'warn');
});

socket.on('playlist:saved', ({ title }) => {
  showToast(`Saved "${title}" to playlist`, 'success');
  renderQueue(); // refresh to show '✓ Saved' state
});

// ---------- Add from input ----------
const addInput = document.getElementById('addInput');
addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addToQueue(); });

document.getElementById('addQueueBtn').onclick = addToQueue;
document.getElementById('addPlaylistBtn').onclick = addToPlaylist;

function addToQueue() {
  const id = extractVideoId(addInput.value);
  if (!id) { alert("Couldn't read a YouTube link/ID from that."); return; }
  addInput.value = '';
  fetchTitle(id).then((title) => {
    socket.emit('queue:add', { id, title });
  });
}

function addToPlaylist() {
  const id = extractVideoId(addInput.value);
  if (!id) { alert("Couldn't read a YouTube link/ID from that."); return; }
  addInput.value = '';
  fetchTitle(id).then((title) => {
    socket.emit('playlist:add', { id, title });
    showToast(`Saved "${title}" to playlist`, 'success');
  });
}

// ---------- Add all to queue ----------
document.getElementById('addAllToQueueBtn').onclick = () => {
  if (!currentPlaylist.length) return;
  socket.emit('playlist:addAllToQueue');
  showToast(`Added ${currentPlaylist.length} song(s) to queue`, 'success');
};

// ---------- Clear queue ----------
document.getElementById('clearQueueBtn').onclick = () => {
  socket.emit('queue:clear');
};

// ---------- Controls ----------
document.getElementById('playBtn').onclick = () => {
  if (currentState.isPlaying) socket.emit('pause', player ? player.getCurrentTime() : 0);
  else socket.emit('play', player ? player.getCurrentTime() : 0);
};
document.getElementById('nextBtn').onclick = () => socket.emit('track:next');
document.getElementById('prevBtn').onclick = () => socket.emit('track:prev');

// Autoplay toggle
function updateAutoplayBtn() {
  const btn = document.getElementById('autoplayBtn');
  if (currentState.autoplay) {
    btn.classList.add('active');
    btn.textContent = '⟳ AUTO';
    btn.title = 'Auto-play is ON — click to turn off';
  } else {
    btn.classList.remove('active');
    btn.textContent = '⟳ OFF';
    btn.title = 'Auto-play is OFF — click to turn on';
  }
}
document.getElementById('autoplayBtn').onclick = () => {
  socket.emit('autoplay:toggle');
};

// Seek bar
const seekBar = document.getElementById('seekBar');
seekBar.addEventListener('mousedown', () => { seekBarDragging = true; });
seekBar.addEventListener('change', () => {
  if (!player) return;
  const duration = player.getDuration() || 0;
  const t = (seekBar.value / 100) * duration;
  socket.emit('seek', t);
  seekBarDragging = false;
});

// ---------- Progress loop ----------
setInterval(() => {
  const playBtn = document.getElementById('playBtn');
  playBtn.textContent = currentState.isPlaying ? '⏸' : '▶';

  if (!playerReady || !player.getDuration) return;
  const duration = player.getDuration() || 0;
  const time = player.getCurrentTime ? player.getCurrentTime() : 0;
  document.getElementById('timeLabel').textContent = `${fmtTime(time)} / ${fmtTime(duration)}`;
  if (!seekBarDragging && duration > 0) {
    seekBar.value = (time / duration) * 100;
  }
}, 500);

// ---------- Chat ----------
const chatLog = document.getElementById('chatLog');
document.getElementById('chatSend').onclick = sendChat;
document.getElementById('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat', msg);
  input.value = '';
}

socket.on('chat', ({ name, msg }) => {
  const div = document.createElement('div');
  div.innerHTML = `<span class="who">${escapeHtml(name)}:</span> ${escapeHtml(msg)}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});
