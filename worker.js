// =============================================================
// Word Guessing Game - Cloudflare Worker + Durable Object
// =============================================================

const MAX_PLAYERS = 5;
const MIN_PLAYERS_TO_PLAY = 2;

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
      let body;
      try {
        body = await request.json();
      } catch {
        return corsResponse(new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 }));
      }

      const username = sanitizeUsername(body.username);
      const wordLength = parseInt(body.wordLength, 10);

      if (!username) {
        return corsResponse(new Response(JSON.stringify({ error: "Username is required" }), { status: 400 }));
      }
      if (!Number.isInteger(wordLength) || wordLength < 3 || wordLength > 10) {
        return corsResponse(new Response(JSON.stringify({ error: "Word length must be 3–10" }), { status: 400 }));
      }

      const roomCode = await generateUniqueRoomCode(env);
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

// Generates a 6-digit room code. Collisions are astronomically unlikely
// given the keyspace, but this keeps things honest without extra ceremony.
async function generateUniqueRoomCode(env) {
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

function sanitizeUsername(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 20) return "";
  return trimmed;
}

function sanitizeClientId(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 100) return "";
  return trimmed;
}

// =============================================================
// Durable Object: GameRoom
// Manages one room's full state and all WebSocket connections
// =============================================================

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
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

    const username = sanitizeUsername(url.searchParams.get("username"));
    const clientId = sanitizeClientId(url.searchParams.get("id"));

    if (!username) {
      return new Response("Username required", { status: 400 });
    }
    if (!clientId) {
      return new Response("Missing client id", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    // Tags: [0] = stable client id (identity used for reconnection),
    //       [1] = display username (unique within the room once joined)
    this.state.acceptWebSocket(server, [clientId, username]);

    return new Response(null, { status: 101, webSocket: client });
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
    const clientId = tags[0];
    const username = tags[1];

    const room = await this.loadState();

    if (!room) {
      ws.send(JSON.stringify({ type: "error", code: "ROOM_NOT_FOUND", message: "This room code doesn't exist." }));
      try { ws.close(4404, "room-not-found"); } catch {}
      return;
    }

    switch (data.type) {
      case "join":
        await this.handleJoin(ws, clientId, username, room);
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
  async webSocketClose(ws) {
    await this.handleDisconnect(ws);
  }

  // Called by DO runtime if the socket errors out (network drop, etc.)
  async webSocketError(ws) {
    await this.handleDisconnect(ws);
  }

  async handleDisconnect(ws) {
    const tags = this.state.getTags(ws);
    const username = tags[1];
    if (!username) return;

    const room = await this.loadState();
    if (!room) return;

    const wasInRoom = room.players.some((p) => p.username === username);
    if (!wasInRoom) return;

    // If it was this player's turn, work out who should go next
    // BEFORE removing them from the rotation.
    let nextTurn = room.currentTurn;
    if (room.phase === "playing" && room.currentTurn === username) {
      const candidate = getNextPlayer(room);
      nextTurn = candidate === username ? null : candidate;
    }

    room.players = room.players.filter((p) => p.username !== username);
    if (room.wrongLetters) delete room.wrongLetters[username];
    if (room.usedLetters) delete room.usedLetters[username];

    if (room.players.length === 0) {
      // Room is fully empty — reset to a clean lobby so the next
      // person to join (e.g. a reconnect) starts fresh, no leftover state.
      const fresh = createEmptyRoom(room.code, room.wordLength);
      await this.saveState(fresh);
      return;
    }

    // Host transfer: if the host left, promote the next available player
    if (room.host === username) {
      room.host = room.players[0].username;
      room.players.forEach((p, i) => { p.isHost = i === 0; });
    }

    if (["words", "countdown", "playing"].includes(room.phase) && room.players.length < MIN_PLAYERS_TO_PLAY) {
      // Not enough players left to continue — end gracefully rather than
      // leaving everyone stuck in a game that can't proceed.
      room.phase = "ended";
      room.winner = null;
      room.winnerWord = null;
      room.endReason = "abandoned";
    } else if (room.phase === "playing") {
      room.currentTurn = nextTurn;
    } else if (room.phase === "words") {
      // Removing a not-yet-ready player might mean everyone left is ready.
      await this.maybeAdvanceFromWords(room);
    }

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  // --- Game Handlers ---

  async handleJoin(ws, clientId, username, room) {
    // Reconnect: this exact browser/tab already has a seat in this room.
    const existing = room.players.find((p) => p.id === clientId);
    if (existing) {
      ws.send(JSON.stringify({
        type: "joined",
        room: sanitizeRoom(room),
        you: existing.username,
        yourWord: existing.secretWord || null,
      }));
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
      return;
    }

    // Not a reconnect — this is a brand new seat request.
    if (room.players.some((p) => p.username === username)) {
      ws.send(JSON.stringify({
        type: "error",
        code: "DUPLICATE_USERNAME",
        message: "That username is already taken in this room.",
      }));
      try { ws.close(4409, "duplicate-username"); } catch {}
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      ws.send(JSON.stringify({ type: "error", code: "ROOM_FULL", message: "This room is full." }));
      try { ws.close(4403, "room-full"); } catch {}
      return;
    }

    if (room.phase !== "lobby") {
      ws.send(JSON.stringify({ type: "error", code: "GAME_IN_PROGRESS", message: "This game has already started." }));
      try { ws.close(4403, "in-progress"); } catch {}
      return;
    }

    const isFirst = room.players.length === 0;
    room.players.push({
      id: clientId,
      username,
      isHost: isFirst,
      ready: false,
      secretWord: null,
      revealedWord: null,
    });

    if (isFirst) room.host = username;

    await this.saveState(room);
    ws.send(JSON.stringify({ type: "joined", room: sanitizeRoom(room), you: username, yourWord: null }));
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleStartGame(ws, username, room) {
    if (room.host !== username) {
      ws.send(JSON.stringify({ type: "error", message: "Only the host can start the game." }));
      return;
    }
    if (room.players.length < MIN_PLAYERS_TO_PLAY) {
      ws.send(JSON.stringify({ type: "error", message: "Need at least 2 players to start." }));
      return;
    }
    if (room.phase !== "lobby") {
      ws.send(JSON.stringify({ type: "error", message: "The game has already started." }));
      return;
    }

    room.phase = "words";
    room.endReason = null;
    room.players.forEach((p) => { p.ready = false; p.secretWord = null; p.revealedWord = null; });

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleSubmitWord(ws, username, word, room) {
    if (room.phase !== "words") {
      ws.send(JSON.stringify({ type: "error", message: "Not in the word submission phase." }));
      return;
    }

    const player = room.players.find((p) => p.username === username);
    if (!player) {
      ws.send(JSON.stringify({ type: "error", message: "Player not found." }));
      return;
    }

    if (!word || !word.trim()) {
      ws.send(JSON.stringify({ type: "error", message: "Your secret word cannot be empty." }));
      return;
    }

    const cleaned = word.trim().toUpperCase();

    if (cleaned.length !== room.wordLength) {
      ws.send(JSON.stringify({ type: "error", message: `Your word must be exactly ${room.wordLength} letters.` }));
      return;
    }

    if (!/^[A-Z]+$/.test(cleaned)) {
      ws.send(JSON.stringify({ type: "error", message: "Your word must contain only letters." }));
      return;
    }

    player.secretWord = cleaned;
    player.ready = true;
    // Revealed word starts as all blanks
    player.revealedWord = "_".repeat(cleaned.length).split("");

    await this.saveState(room);
    ws.send(JSON.stringify({ type: "wordAccepted" }));
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });

    await this.maybeAdvanceFromWords(room);
  }

  // If every remaining player has submitted a word, move the room into
  // the countdown phase. Shared by both normal submission and disconnects
  // (since a disconnect can remove the last not-ready player).
  async maybeAdvanceFromWords(room) {
    if (room.phase !== "words") return;
    if (room.players.length < MIN_PLAYERS_TO_PLAY) return;
    const allReady = room.players.length > 0 && room.players.every((p) => p.ready);
    if (!allReady) return;

    room.phase = "countdown";
    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    await this.scheduleCountdown();
  }

  async scheduleCountdown() {
    const alarmTime = Date.now() + 5000;
    await this.state.storage.setAlarm(alarmTime);
  }

  async alarm() {
    const room = await this.loadState();
    if (!room) return;

    if (room.phase !== "countdown") return;

    if (room.players.length < MIN_PLAYERS_TO_PLAY) {
      room.phase = "ended";
      room.winner = null;
      room.winnerWord = null;
      room.endReason = "abandoned";
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
      return;
    }

    room.phase = "playing";
    room.currentTurn = room.players[0].username;
    room.wrongLetters = {};
    room.usedLetters = {};
    room.players.forEach((p) => {
      room.wrongLetters[p.username] = [];
      room.usedLetters[p.username] = [];
    });
    room.winner = null;
    room.winnerWord = null;
    room.endReason = null;

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleAskLetter(ws, username, letter, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "The game is not currently in progress." }));
      return;
    }
    if (room.currentTurn !== username) {
      ws.send(JSON.stringify({ type: "error", message: "It's not your turn." }));
      return;
    }

    if (!letter || letter.length !== 1 || !/^[A-Za-z]$/.test(letter)) {
      ws.send(JSON.stringify({ type: "error", message: "Enter a single letter (A–Z)." }));
      return;
    }

    const L = letter.toUpperCase();

    const target = getTargetPlayer(room, username);
    if (!target) {
      ws.send(JSON.stringify({ type: "error", message: "No target player found." }));
      return;
    }

    if (!room.usedLetters[target.username]) room.usedLetters[target.username] = [];
    if (room.usedLetters[target.username].includes(L)) {
      ws.send(JSON.stringify({ type: "error", message: "That letter has already been guessed for this word." }));
      return;
    }

    room.usedLetters[target.username].push(L);

    const secretWord = target.secretWord;
    const found = secretWord.includes(L);

    if (found) {
      for (let i = 0; i < secretWord.length; i++) {
        if (secretWord[i] === L) {
          target.revealedWord[i] = L;
        }
      }
      if (!target.revealedWord.includes("_")) {
        // Auto-win if the word is fully revealed by letters
        room.winner = username;
        room.winnerWord = secretWord;
        room.phase = "ended";
        room.endReason = "win";
        await this.saveState(room);
        this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
        return;
      }
    } else {
      if (!room.wrongLetters[target.username]) room.wrongLetters[target.username] = [];
      room.wrongLetters[target.username].push(L);
    }

    this.broadcast(room, {
      type: "letterResult",
      asker: username,
      target: target.username,
      letter: L,
      found,
    });

    room.currentTurn = getNextPlayer(room);
    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleGuessWord(ws, username, word, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "The game is not currently in progress." }));
      return;
    }
    if (room.currentTurn !== username) {
      ws.send(JSON.stringify({ type: "error", message: "It's not your turn." }));
      return;
    }

    if (!word || !word.trim()) {
      ws.send(JSON.stringify({ type: "error", message: "Enter a word to guess." }));
      return;
    }

    const guess = word.trim().toUpperCase();
    const target = getTargetPlayer(room, username);

    if (!target) {
      ws.send(JSON.stringify({ type: "error", message: "No target player found." }));
      return;
    }

    if (guess === target.secretWord) {
      room.winner = username;
      room.winnerWord = target.secretWord;
      room.phase = "ended";
      room.endReason = "win";
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    } else {
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
      ws.send(JSON.stringify({ type: "error", message: "Only the host can restart the game." }));
      return;
    }

    room.phase = "lobby";
    room.players.forEach((p) => {
      p.ready = false;
      p.secretWord = null;
      p.revealedWord = null;
    });
    room.currentTurn = null;
    room.winner = null;
    room.winnerWord = null;
    room.endReason = null;
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
        if (playerNames.has(tags[1])) {
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
    wordLength: parseInt(wordLength, 10),
    phase: "lobby",   // lobby | words | countdown | playing | ended
    host: null,
    players: [],
    currentTurn: null,
    wrongLetters: {},
    usedLetters: {},
    winner: null,
    winnerWord: null,
    endReason: null,  // "win" | "abandoned" | null
  };
}

// Remove secret words from state before sending to clients.
// secretWord is NEVER included here — a player's own word is sent
// separately, only over their own connection, in the "joined" message.
function sanitizeRoom(room) {
  return {
    code: room.code,
    wordLength: room.wordLength,
    phase: room.phase,
    host: room.host,
    currentTurn: room.currentTurn,
    winner: room.winner,
    winnerWord: room.phase === "ended" ? room.winnerWord : null,
    endReason: room.endReason,
    wrongLetters: room.wrongLetters,
    players: room.players.map((p) => ({
      username: p.username,
      isHost: p.isHost,
      ready: p.ready,
      // revealedWord only ever shows letters already guessed correctly —
      // safe to send to everyone.
      revealedWord: p.revealedWord,
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