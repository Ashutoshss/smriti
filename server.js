const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Persistent playlist (saved to disk) ---
const PLAYLIST_FILE = path.join(__dirname, 'playlist.json');

function loadPlaylist() {
  try {
    if (fs.existsSync(PLAYLIST_FILE)) {
      const data = fs.readFileSync(PLAYLIST_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('Error loading playlist.json, starting fresh:', err.message);
  }
  return [];
}

function savePlaylist() {
  try {
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving playlist.json:', err.message);
  }
}

let playlist = loadPlaylist(); // [{ id, title, addedBy }]

// --- Session queue state (not persisted) ---
const state = {
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  seekTime: 0,       // seconds, position at lastUpdate
  lastUpdate: Date.now(),
  autoplay: true,
};

function getComputedTime() {
  if (!state.isPlaying) return state.seekTime;
  const elapsed = (Date.now() - state.lastUpdate) / 1000;
  return state.seekTime + elapsed;
}

function publicState() {
  return {
    queue: state.queue,
    currentIndex: state.currentIndex,
    isPlaying: state.isPlaying,
    seekTime: getComputedTime(),
    lastUpdate: Date.now(),
    autoplay: state.autoplay,
  };
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current state + playlist to the newly connected client
  socket.emit('state', publicState());
  socket.emit('playlist:state', playlist);

  // Someone renamed themselves / joined
  socket.on('identify', (name) => {
    socket.data.name = name || 'Someone';
    io.emit('presence', { id: socket.id, name: socket.data.name, event: 'join' });
  });

  // =========== QUEUE EVENTS ===========

  // Add a video directly to the queue (no duplicates)
  socket.on('queue:add', ({ id, title }) => {
    const exists = state.queue.some((q) => q.id === id);
    if (exists) {
      socket.emit('queue:duplicate', { id, title: title || id });
      return;
    }
    state.queue.push({ id, title: title || id, addedBy: socket.data.name || 'Someone' });
    // If nothing was playing, auto-load the first thing added
    if (state.currentIndex === -1) {
      state.currentIndex = 0;
      state.isPlaying = false;
      state.seekTime = 0;
      state.lastUpdate = Date.now();
    }
    io.emit('state', publicState());
  });

  socket.on('queue:remove', (index) => {
    if (index < 0 || index >= state.queue.length) return;
    state.queue.splice(index, 1);
    if (state.queue.length === 0) {
      state.currentIndex = -1;
      state.isPlaying = false;
      state.seekTime = 0;
      state.lastUpdate = Date.now();
    } else if (state.currentIndex >= state.queue.length) {
      state.currentIndex = state.queue.length - 1;
    } else if (index < state.currentIndex) {
      state.currentIndex -= 1;
    }
    io.emit('state', publicState());
  });

  socket.on('queue:clear', () => {
    state.queue = [];
    state.currentIndex = -1;
    state.isPlaying = false;
    state.seekTime = 0;
    state.lastUpdate = Date.now();
    io.emit('state', publicState());
  });

  // Save a queue item to the persistent playlist
  socket.on('queue:saveToPlaylist', (index) => {
    if (index < 0 || index >= state.queue.length) return;
    const item = state.queue[index];
    const exists = playlist.some((p) => p.id === item.id);
    if (exists) {
      socket.emit('playlist:duplicate', { id: item.id, title: item.title });
      return;
    }
    playlist.push({ id: item.id, title: item.title, addedBy: item.addedBy });
    savePlaylist();
    io.emit('playlist:state', playlist);
    socket.emit('playlist:saved', { title: item.title });
  });

  // =========== PLAYLIST EVENTS ===========

  // Save a video to the persistent playlist (no duplicates)
  socket.on('playlist:add', ({ id, title }) => {
    const exists = playlist.some((item) => item.id === id);
    if (exists) {
      socket.emit('playlist:duplicate', { id, title });
      return;
    }
    playlist.push({ id, title: title || id, addedBy: socket.data.name || 'Someone' });
    savePlaylist();
    io.emit('playlist:state', playlist);
  });

  // Remove from persistent playlist
  socket.on('playlist:remove', (index) => {
    if (index < 0 || index >= playlist.length) return;
    playlist.splice(index, 1);
    savePlaylist();
    io.emit('playlist:state', playlist);
  });

  // Add one playlist item to queue (no duplicates)
  socket.on('playlist:addToQueue', (index) => {
    if (index < 0 || index >= playlist.length) return;
    const item = playlist[index];
    const exists = state.queue.some((q) => q.id === item.id);
    if (exists) {
      socket.emit('queue:duplicate', { id: item.id, title: item.title });
      return;
    }
    state.queue.push({ id: item.id, title: item.title, addedBy: socket.data.name || 'Someone' });
    if (state.currentIndex === -1) {
      state.currentIndex = 0;
      state.isPlaying = false;
      state.seekTime = 0;
      state.lastUpdate = Date.now();
    }
    io.emit('state', publicState());
  });

  // Add all playlist items to queue (skip duplicates)
  socket.on('playlist:addAllToQueue', () => {
    if (playlist.length === 0) return;
    let added = 0;
    playlist.forEach((item) => {
      const exists = state.queue.some((q) => q.id === item.id);
      if (!exists) {
        state.queue.push({ id: item.id, title: item.title, addedBy: socket.data.name || 'Someone' });
        added++;
      }
    });
    if (added === 0) {
      socket.emit('queue:duplicate', { id: '', title: 'All songs are already in the queue' });
      return;
    }
    if (state.currentIndex === -1) {
      state.currentIndex = 0;
      state.isPlaying = false;
      state.seekTime = 0;
      state.lastUpdate = Date.now();
    }
    io.emit('state', publicState());
  });

  // Click a playlist song to play it immediately
  socket.on('playlist:play', (index) => {
    if (index < 0 || index >= playlist.length) return;
    const item = playlist[index];
    // Check if already in queue
    const queueIndex = state.queue.findIndex((q) => q.id === item.id);
    if (queueIndex >= 0) {
      // Already in queue — just jump to it
      state.currentIndex = queueIndex;
    } else {
      // Add to queue and jump to it
      state.queue.push({ id: item.id, title: item.title, addedBy: socket.data.name || 'Someone' });
      state.currentIndex = state.queue.length - 1;
    }
    state.isPlaying = true;
    state.seekTime = 0;
    state.lastUpdate = Date.now();
    io.emit('state', publicState());
  });

  // =========== PLAYBACK CONTROLS ===========

  socket.on('play', (atTime) => {
    state.isPlaying = true;
    state.seekTime = typeof atTime === 'number' ? atTime : getComputedTime();
    state.lastUpdate = Date.now();
    io.emit('state', publicState());
  });

  socket.on('pause', (atTime) => {
    state.isPlaying = false;
    state.seekTime = typeof atTime === 'number' ? atTime : getComputedTime();
    state.lastUpdate = Date.now();
    io.emit('state', publicState());
  });

  socket.on('seek', (toTime) => {
    state.seekTime = toTime;
    state.lastUpdate = Date.now();
    io.emit('state', publicState());
  });

  socket.on('track:select', (index) => {
    if (index < 0 || index >= state.queue.length) return;
    state.currentIndex = index;
    state.isPlaying = true;
    state.seekTime = 0;
    state.lastUpdate = Date.now();
    io.emit('state', publicState());
  });

  socket.on('track:next', () => {
    if (state.currentIndex + 1 < state.queue.length) {
      state.currentIndex += 1;
      state.isPlaying = true;
      state.seekTime = 0;
      state.lastUpdate = Date.now();
      io.emit('state', publicState());
    } else {
      // End of queue
      state.isPlaying = false;
      state.seekTime = 0;
      state.lastUpdate = Date.now();
      io.emit('state', publicState());
    }
  });

  socket.on('track:prev', () => {
    if (state.currentIndex - 1 >= 0) {
      state.currentIndex -= 1;
      state.isPlaying = true;
      state.seekTime = 0;
      state.lastUpdate = Date.now();
      io.emit('state', publicState());
    }
  });

  // =========== AUTOPLAY TOGGLE ===========

  socket.on('autoplay:toggle', () => {
    state.autoplay = !state.autoplay;
    io.emit('state', publicState());
  });

  // =========== CHAT ===========

  socket.on('chat', (msg) => {
    io.emit('chat', { name: socket.data.name || 'Someone', msg, time: Date.now() });
  });

  socket.on('disconnect', () => {
    io.emit('presence', { id: socket.id, name: socket.data.name || 'Someone', event: 'leave' });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵 LAN Music Sync running!`);
  console.log(`   On this machine:  http://localhost:${PORT}`);
  console.log(`   On your network:  http://<your-LAN-IP>:${PORT}  (see README for how to find it)`);
  console.log(`   Playlist: ${playlist.length} saved song(s) loaded from playlist.json\n`);
});
