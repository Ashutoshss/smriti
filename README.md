# Together — you and me, in sync

with `together` two people on the same network to listen to YouTube
videos together, perfectly in sync (play, pause, seek, skip). Nothing is
downloaded or stored — it streams straight from YouTube.

---

## 1. One of you runs the server

Only **one** of you needs to do this part — say, on the Ubuntu machine.

### Install Node.js (if you don't have it)

**Ubuntu:**
```bash
sudo apt update
sudo apt install -y nodejs npm
node --version   # should print v18 or higher
```

**Windows** (only needed if you want the Windows machine to be the host
instead): download and install from https://nodejs.org (LTS version).

### Start the app

```bash
cd you
npm install
npm start
```

You'll see:
```
🎵 LAN Music Sync running!
   On this machine:  http://localhost:3000
   On your network:  http://<your-LAN-IP>:3000
```

## 2. Find your LAN IP address

On the machine running the server:

**Ubuntu:**
```bash
hostname -I
```
(use the first address shown, usually starts with `192.168.` or `10.`)

**Windows** (if you're hosting instead):
```
ipconfig
```
Look for "IPv4 Address" under your active adapter.

## 3. Connect

- **Host machine:** open `http://localhost:3000`
- **Other machine (same Wi-Fi/network):** open `http://<that-IP>:3000`,
  e.g. `http://192.168.1.42:3000`

Both of you type in a name, and you're in the same room automatically —
it's a single shared room, built for two.

## 4. Add and play music

- Paste any YouTube link (or just the video ID) into the box and hit
  **Add to queue**.
- Click a song in the queue to play it.
- Play/pause/seek/skip from **either** side syncs to the other, live.
- There's a small chat box too.
