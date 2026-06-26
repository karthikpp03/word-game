// =============================================================
// Word Guessing Game - Cloudflare Worker + Durable Object
// =============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Route: WebSocket upgrade for game room
    if (url.pathname.startsWith("/room/")) {
      const roomCode = url.pathname.split("/")[2];
      if (!roomCode) return corsResponse(new Response("Missing room code", { status: 400 }));

      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // Route: Create room (HTTP)
    if (url.pathname === "/create" && request.method === "POST") {
      const body = await request.json();
      const { username, wordLength } = body;

      if (!username || !username.trim()) {
        return corsResponse(new Response(JSON.stringify({ error: "Username is required" }), { status: 400 }));
      }
      if (!wordLength || wordLength < 3 || wordLength > 10) {
        return corsResponse(new Response(JSON.stringify({ error: "Word length must be 3–10" }), { status: 400 }));
      }

      const roomCode = generateRoomCode();
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);

      const resp = await stub.fetch(new Request("https://internal/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomCode, wordLength }),
      }));

      if (!resp.ok) {
        return corsResponse(new Response(JSON.stringify({ error: "Failed to create room" }), { status: 500 }));
      }

      return corsResponse(new Response(JSON.stringify({ roomCode }), { status: 200 }));
    }

    return corsResponse(new Response("Not found", { status: 404 }));
  },
};

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// =============================================================
// Durable Object: GameRoom
// Manages one room's full state and all WebSocket connections
// =============================================================

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // socketId -> { ws, username }
    this.initialized = false;
  }

  // Load room state from durable storage
  async loadState() {
    const stored = await this.state.storage.get("room");
    return stored || null;
  }

  // Save room state to durable storage
  async saveState(room) {
    await this.state.storage.put("room", room);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal init route called when creating a room
    if (url.pathname === "/init" && request.method === "POST") {
      const body = await request.json();
      const existing = await this.loadState();
      if (existing) {
        return new Response(JSON.stringify({ ok: true })); // Already exists
      }
      const room = createEmptyRoom(body.roomCode, body.wordLength);
      await this.saveState(room);
      return new Response(JSON.stringify({ ok: true }));
    }

    // WebSocket upgrade
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url2 = new URL(request.url);
    const username = url2.searchParams.get("username")?.trim();

    if (!username) {
      return new Response("Username required", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server, username);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(ws, username) {
    this.state.acceptWebSocket(ws, [username]);
  }

  // Called by DO runtime when a WebSocket message is received
  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const tags = this.state.getTags(ws);
    const username = tags[0];

    const room = await this.loadState();

    if (!room) {
      ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
      return;
    }

    switch (data.type) {
      case "join":
        await this.handleJoin(ws, username, room);
        break;
      case "submitWord":
        await this.handleSubmitWord(ws, username, data.word, room);
        break;
      case "askLetter":
        await this.handleAskLetter(ws, username, data.letter, room);
        break;
      case "guessWord":
        await this.handleGuessWord(ws, username, data.word, room);
        break;
      case "startGame":
        await this.handleStartGame(ws, username, room);
        break;
      case "playAgain":
        await this.handlePlayAgain(ws, username, room);
        break;
      default:
        ws.send(JSON.stringify({ type: "error", message: "Unknown action" }));
    }
  }

  // Called by DO runtime when a WebSocket closes
  async webSocketClose(ws, code, reason) {
    const tags = this.state.getTags(ws);
    const username = tags[0];

    const room = await this.loadState();
    if (!room) return;

    // Remove player from room
    room.players = room.players.filter((p) => p.username !== username);

    // If host left and there are still players, assign new host
    if (room.players.length > 0 && room.host === username) {
      room.host = room.players[0].username;
      room.players[0].isHost = true;
    }

    // If game in progress and current turn player left, advance turn
    if (room.phase === "playing" && room.currentTurn === username) {
      room.currentTurn = getNextPlayer(room);
    }

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  // --- Game Handlers ---

  async handleJoin(ws, username, room) {
    // Validate join
    if (room.players.find((p) => p.username === username)) {
      // Already in room (reconnect) — just send state
      ws.send(JSON.stringify({ type: "joined", room: sanitizeRoom(room), you: username }));
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
      return;
    }

    if (room.players.length >= 5) {
      ws.send(JSON.stringify({ type: "error", message: "Room is full" }));
      return;
    }

    if (room.phase !== "lobby") {
      ws.send(JSON.stringify({ type: "error", message: "Game already in progress" }));
      return;
    }

    const isFirst = room.players.length === 0;
    room.players.push({
      username,
      isHost: isFirst,
      ready: false,
      secretWord: null,
      revealedWord: null,
    });

    if (isFirst) room.host = username;

    await this.saveState(room);
    ws.send(JSON.stringify({ type: "joined", room: sanitizeRoom(room), you: username }));
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleStartGame(ws, username, room) {
    if (room.host !== username) {
      ws.send(JSON.stringify({ type: "error", message: "Only the host can start the game" }));
      return;
    }
    if (room.players.length < 2) {
      ws.send(JSON.stringify({ type: "error", message: "Need at least 2 players" }));
      return;
    }
    if (room.phase !== "lobby") {
      ws.send(JSON.stringify({ type: "error", message: "Game already started" }));
      return;
    }

    room.phase = "words";
    room.players.forEach((p) => { p.ready = false; p.secretWord = null; p.revealedWord = null; });

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleSubmitWord(ws, username, word, room) {
    if (room.phase !== "words") {
      ws.send(JSON.stringify({ type: "error", message: "Not in word submission phase" }));
      return;
    }

    const player = room.players.find((p) => p.username === username);
    if (!player) {
      ws.send(JSON.stringify({ type: "error", message: "Player not found" }));
      return;
    }

    if (!word || !word.trim()) {
      ws.send(JSON.stringify({ type: "error", message: "Word cannot be empty" }));
      return;
    }

    const cleaned = word.trim().toUpperCase();

    if (cleaned.length !== room.wordLength) {
      ws.send(JSON.stringify({ type: "error", message: `Word must be exactly ${room.wordLength} letters` }));
      return;
    }

    if (!/^[A-Z]+$/.test(cleaned)) {
      ws.send(JSON.stringify({ type: "error", message: "Word must contain only letters" }));
      return;
    }

    player.secretWord = cleaned;
    player.ready = true;
    // Revealed word starts as all blanks
    player.revealedWord = "_".repeat(cleaned.length).split("");

    const allReady = room.players.every((p) => p.ready);

    if (allReady) {
      // Begin countdown phase
      room.phase = "countdown";
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });

      // After 5 seconds, begin playing
      await this.scheduleCountdown(room);
    } else {
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    }
  }

  async scheduleCountdown(room) {
    // Use alarms for countdown (5 seconds)
    const alarmTime = Date.now() + 5000;
    await this.state.storage.put("alarmRoom", room.code);
    await this.state.storage.setAlarm(alarmTime);
  }

  async alarm() {
    const room = await this.loadState();
    if (!room) return;

    if (room.phase === "countdown") {
      room.phase = "playing";
      // Pick starting player
      room.currentTurn = room.players[0].username;
      room.wrongLetters = {};
      room.usedLetters = {};
      // Init wrong letters and used letters per player's word
      room.players.forEach((p) => {
        room.wrongLetters[p.username] = [];
        room.usedLetters[p.username] = [];
      });
      room.winner = null;

      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    }
  }

  async handleAskLetter(ws, username, letter, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "Game is not in playing phase" }));
      return;
    }
    if (room.currentTurn !== username) {
      ws.send(JSON.stringify({ type: "error", message: "It's not your turn" }));
      return;
    }

    if (!letter || letter.length !== 1 || !/^[A-Za-z]$/.test(letter)) {
      ws.send(JSON.stringify({ type: "error", message: "Enter a single valid letter" }));
      return;
    }

    const L = letter.toUpperCase();

    // Find the next player (whose secret word we are guessing)
    const target = getTargetPlayer(room, username);
    if (!target) {
      ws.send(JSON.stringify({ type: "error", message: "No target player found" }));
      return;
    }

    // Check if letter already used against this target
    if (!room.usedLetters[target.username]) room.usedLetters[target.username] = [];
    if (room.usedLetters[target.username].includes(L)) {
      ws.send(JSON.stringify({ type: "error", message: "Letter already used" }));
      return;
    }

    room.usedLetters[target.username].push(L);

    const secretWord = target.secretWord;
    const found = secretWord.includes(L);

    if (found) {
      // Reveal all occurrences
      for (let i = 0; i < secretWord.length; i++) {
        if (secretWord[i] === L) {
          target.revealedWord[i] = L;
        }
      }
      // Check if word is fully revealed
      if (!target.revealedWord.includes("_")) {
        // Auto-win if word fully revealed by letters
        room.winner = username;
        room.winnerWord = secretWord;
        room.phase = "ended";
        await this.saveState(room);
        this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
        return;
      }
    } else {
      if (!room.wrongLetters[target.username]) room.wrongLetters[target.username] = [];
      room.wrongLetters[target.username].push(L);
    }

    // Broadcast letter result event
    this.broadcast(room, {
      type: "letterResult",
      asker: username,
      target: target.username,
      letter: L,
      found,
    });

    // Advance turn
    room.currentTurn = getNextPlayer(room);
    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleGuessWord(ws, username, word, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "Game is not in playing phase" }));
      return;
    }
    if (room.currentTurn !== username) {
      ws.send(JSON.stringify({ type: "error", message: "It's not your turn" }));
      return;
    }

    if (!word || !word.trim()) {
      ws.send(JSON.stringify({ type: "error", message: "Enter a word to guess" }));
      return;
    }

    const guess = word.trim().toUpperCase();
    const target = getTargetPlayer(room, username);

    if (!target) {
      ws.send(JSON.stringify({ type: "error", message: "No target player found" }));
      return;
    }

    if (guess === target.secretWord) {
      room.winner = username;
      room.winnerWord = target.secretWord;
      room.phase = "ended";
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    } else {
      // Wrong guess — notify and advance turn
      this.broadcast(room, {
        type: "wrongGuess",
        guesser: username,
        guess,
      });
      room.currentTurn = getNextPlayer(room);
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    }
  }

  async handlePlayAgain(ws, username, room) {
    if (room.host !== username) {
      ws.send(JSON.stringify({ type: "error", message: "Only the host can restart" }));
      return;
    }

    // Reset to lobby
    room.phase = "lobby";
    room.players.forEach((p) => {
      p.ready = false;
      p.secretWord = null;
      p.revealedWord = null;
    });
    room.currentTurn = null;
    room.winner = null;
    room.winnerWord = null;
    room.wrongLetters = {};
    room.usedLetters = {};

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  // Broadcast a message to all active WebSocket connections in this room
  broadcast(room, message) {
    const str = JSON.stringify(message);
    const playerNames = new Set(room.players.map((p) => p.username));
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      try {
        const tags = this.state.getTags(ws);
        // Only send to players in the room
        if (playerNames.has(tags[0])) {
          ws.send(str);
        }
      } catch {}
    }
  }
}

// =============================================================
// Helpers
// =============================================================

function createEmptyRoom(code, wordLength) {
  return {
    code,
    wordLength: parseInt(wordLength),
    phase: "lobby",   // lobby | words | countdown | playing | ended
    host: null,
    players: [],
    currentTurn: null,
    wrongLetters: {},
    usedLetters: {},
    winner: null,
    winnerWord: null,
  };
}

// Remove secret words from state before sending to clients
// Each client will only see their own secret word
function sanitizeRoom(room) {
  return {
    ...room,
    players: room.players.map((p) => ({
      username: p.username,
      isHost: p.isHost,
      ready: p.ready,
      // revealedWord is safe to send — it only shows guessed letters
      revealedWord: p.revealedWord,
      // secretWord is NOT included here — sent only when needed via "joined" to owner
      hasWord: !!p.secretWord,
    })),
  };
}

// Get the next player in turn order
function getNextPlayer(room) {
  const activePlayers = room.players;
  if (!activePlayers.length) return null;
  const idx = activePlayers.findIndex((p) => p.username === room.currentTurn);
  return activePlayers[(idx + 1) % activePlayers.length].username;
}

// The player whose secret word is being guessed this turn
// = the player immediately after the current guesser in order
function getTargetPlayer(room, currentUsername) {
  const players = room.players;
  const idx = players.findIndex((p) => p.username === currentUsername);
  if (idx === -1) return null;
  return players[(idx + 1) % players.length];
}