// =============================================================
// Word Guessing Game - Cloudflare Worker + Durable Object
// =============================================================

const MAX_PLAYERS = 6;
const MIN_PLAYERS_TO_PLAY = 2;
const ALLOWED_REACTION_EMOJIS = ["😂", "😭", "😡", "😱", "❤️", "👏", "🔥", "👍", "🤯", "🎉"];
const REACTION_COOLDOWN_MS = 3000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    if (url.pathname.startsWith("/room/")) {
      const roomCode = url.pathname.split("/")[2];
      if (!roomCode) return corsResponse(new Response("Missing room code", { status: 400 }));
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/create" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch {
        return corsResponse(new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 }));
      }

      const username = sanitizeUsername(body.username);
      const wordLength = parseInt(body.wordLength, 10);
      const gameMode = body.gameMode === "team" ? "team" : "classic";

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
        body: JSON.stringify({ roomCode, wordLength, gameMode }),
      }));

      if (!resp.ok) {
        return corsResponse(new Response(JSON.stringify({ error: "Failed to create room" }), { status: 500 }));
      }

      return corsResponse(new Response(JSON.stringify({ roomCode }), { status: 200 }));
    }

    return corsResponse(new Response("Not found", { status: 404 }));
  },
};

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
// =============================================================

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Tracks clientIds whose old socket we are intentionally closing because
    // a newer connection for the same client just took over (see handleJoin).
    // Their close event should NOT be treated as a real player disconnect.
    this.pendingDedupClientIds = new Set();
    // Per-username cooldown tracking for emoji reactions (server-side anti-spam).
    this.lastReactionAt = new Map();
  }

  async loadState() {
    const stored = await this.state.storage.get("room");
    return stored || null;
  }

  async saveState(room) {
    await this.state.storage.put("room", room);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      const body = await request.json();
      const existing = await this.loadState();
      if (existing) return new Response(JSON.stringify({ ok: true }));
      const room = createEmptyRoom(body.roomCode, body.wordLength, body.gameMode || "classic");
      await this.saveState(room);
      return new Response(JSON.stringify({ ok: true }));
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const username = sanitizeUsername(url.searchParams.get("username"));
    const clientId = sanitizeClientId(url.searchParams.get("id"));

    if (!username) return new Response("Username required", { status: 400 });
    if (!clientId) return new Response("Missing client id", { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [clientId, username]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return; }

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
      case "join":           await this.handleJoin(ws, clientId, username, room); break;
      case "submitWord":     await this.handleSubmitWord(ws, username, data.word, room); break;
      case "askLetter":      await this.handleAskLetter(ws, username, data.letter, room); break;
      case "guessWord":      await this.handleGuessWord(ws, username, data.word, room); break;
      case "startGame":      await this.handleStartGame(ws, username, room); break;
      case "playAgain":      await this.handlePlayAgain(ws, username, room); break;
      // Team Battle messages
      case "joinTeam":       await this.handleJoinTeam(ws, username, data.team, room); break;
      case "setLeader":      await this.handleSetLeader(ws, username, data.target, room); break;
      case "startTeamGame":  await this.handleStartTeamGame(ws, username, room); break;
      case "suggestAction":  await this.handleSuggestAction(ws, username, data, room); break;
      case "endTurn":        await this.handleEndTurn(ws, username, room); break;
      case "teamChat":       await this.handleTeamChat(ws, username, data.message, room); break;
      case "globalChat":     await this.handleGlobalChat(ws, username, data.message, room); break;
      case "reaction":       await this.handleReaction(ws, username, data.emoji, room); break;
      default:
        ws.send(JSON.stringify({ type: "error", message: "Unknown action" }));
    }
  }

  async webSocketClose(ws) { await this.handleDisconnect(ws); }
  async webSocketError(ws)  { await this.handleDisconnect(ws); }

  async handleDisconnect(ws) {
    const tags = this.state.getTags(ws);
    const clientId = tags[0];
    const username = tags[1];
    if (!username) return;

    // This socket was closed intentionally because a newer connection for
    // the same client already took over — the player isn't actually gone.
    if (clientId && this.pendingDedupClientIds.has(clientId)) {
      this.pendingDedupClientIds.delete(clientId);
      return;
    }

    const room = await this.loadState();
    if (!room) return;

    const wasInRoom = room.players.some((p) => p.username === username);
    if (!wasInRoom) return;

    let nextTurn = room.currentTurn;
    if (room.phase === "playing" && room.currentTurn === username) {
      const candidate = getNextPlayer(room);
      nextTurn = candidate === username ? null : candidate;
    }

    room.players = room.players.filter((p) => p.username !== username);

    // Clean up team membership
    if (room.gameMode === "team") {
      ["A", "B"].forEach(t => {
        if (room.teams[t]) {
          room.teams[t].members = room.teams[t].members.filter(m => m !== username);
          if (room.teams[t].leader === username) room.teams[t].leader = null;
          maybeAutoAssignLeader(room, t);
        }
      });
    }

    if (room.wrongLetters)  delete room.wrongLetters[username];
    if (room.usedLetters)   delete room.usedLetters[username];

    if (room.players.length === 0) {
      const fresh = createEmptyRoom(room.code, room.wordLength, room.gameMode);
      await this.saveState(fresh);
      return;
    }

    if (room.host === username) {
      room.host = room.players[0].username;
      room.players.forEach((p, i) => { p.isHost = i === 0; });
    }

    if (["words", "countdown", "playing"].includes(room.phase) && room.players.length < MIN_PLAYERS_TO_PLAY) {
      room.phase = "ended";
      room.winner = null;
      room.winnerWord = null;
      room.endReason = "abandoned";
    } else if (room.phase === "playing") {
      room.currentTurn = nextTurn;
    } else if (room.phase === "words") {
      await this.maybeAdvanceFromWords(room);
    }

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  // --- Handlers ---

  async handleJoin(ws, clientId, username, room) {
    // Connection fix: close any stale/duplicate sockets already attached for this
    // client or username before continuing, so each player only ever has one
    // live WebSocket attached to the Durable Object.
    for (const otherWs of this.state.getWebSockets()) {
      if (otherWs === ws) continue;
      try {
        const otherTags = this.state.getTags(otherWs);
        if (otherTags[0] === clientId || otherTags[1] === username) {
          if (otherTags[0]) this.pendingDedupClientIds.add(otherTags[0]);
          try { otherWs.close(4000, "duplicate-connection"); } catch {}
        }
      } catch {}
    }

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

    if (room.players.some((p) => p.username === username)) {
      ws.send(JSON.stringify({ type: "error", code: "DUPLICATE_USERNAME", message: "That username is already taken in this room." }));
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
    room.players.push({ id: clientId, username, isHost: isFirst, ready: false, secretWord: null, revealedWord: null });
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

    if (room.gameMode === "team") {
      // Move to team selection phase instead of words
      room.phase = "teams";
      room.teams = { A: { members: [], leader: null }, B: { members: [], leader: null } };
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
      return;
    }

    room.phase = "words";
    room.endReason = null;
    room.players.forEach((p) => { p.ready = false; p.secretWord = null; p.revealedWord = null; });
    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  // ---- Team Battle handlers ----

  async handleJoinTeam(ws, username, team, room) {
    if (room.phase !== "teams") {
      ws.send(JSON.stringify({ type: "error", message: "Not in team selection phase." }));
      return;
    }
    if (!["A", "B"].includes(team)) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid team." }));
      return;
    }

    // Remove from current team first
    ["A", "B"].forEach(t => {
      room.teams[t].members = room.teams[t].members.filter(m => m !== username);
      if (room.teams[t].leader === username) room.teams[t].leader = null;
      maybeAutoAssignLeader(room, t);
    });

    room.teams[team].members.push(username);
    // A lone player on a team is automatically the leader. Once a second
    // player joins, the team keeps its existing leader (manual selection
    // is available via "setLeader") instead of being reassigned.
    maybeAutoAssignLeader(room, team);
    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleSetLeader(ws, username, target, room) {
    if (room.phase !== "teams") {
      ws.send(JSON.stringify({ type: "error", message: "Not in team selection phase." }));
      return;
    }

    // Find which team the setter is on
    const myTeam = ["A", "B"].find(t => room.teams[t].members.includes(username));
    if (!myTeam) {
      ws.send(JSON.stringify({ type: "error", message: "You must be on a team to set a leader." }));
      return;
    }

    // Target must be on same team
    if (!room.teams[myTeam].members.includes(target)) {
      ws.send(JSON.stringify({ type: "error", message: "You can only select a leader from your own team." }));
      return;
    }

    room.teams[myTeam].leader = target;
    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleStartTeamGame(ws, username, room) {
    if (room.host !== username) {
      ws.send(JSON.stringify({ type: "error", message: "Only the host can start the game." }));
      return;
    }
    if (room.phase !== "teams") {
      ws.send(JSON.stringify({ type: "error", message: "Not in team selection phase." }));
      return;
    }

    // Validate all players are on a team, both teams have members and a leader
    const allOnTeam = room.players.every(p =>
      room.teams.A.members.includes(p.username) || room.teams.B.members.includes(p.username)
    );
    if (!allOnTeam) {
      ws.send(JSON.stringify({ type: "error", message: "All players must join a team." }));
      return;
    }
    if (room.teams.A.members.length === 0 || room.teams.B.members.length === 0) {
      ws.send(JSON.stringify({ type: "error", message: "Both teams must have at least one player." }));
      return;
    }
    if (!room.teams.A.leader || !room.teams.B.leader) {
      ws.send(JSON.stringify({ type: "error", message: "Both teams must have a leader." }));
      return;
    }

    room.phase = "words";
    room.endReason = null;
    room.players.forEach((p) => { p.ready = false; p.secretWord = null; p.revealedWord = null; });
    room.teams.A.secretWord = null;
    room.teams.B.secretWord = null;
    // Team turns: track which team's turn it is (leaders alternate)
    room.teamTurn = "A"; // Team A goes first
    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleSuggestAction(ws, username, data, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "Game is not in progress." }));
      return;
    }

    const myTeam = ["A", "B"].find(t => room.teams && room.teams[t].members.includes(username));
    if (!myTeam) return;

    const leader = room.teams[myTeam].leader;
    if (!leader || leader === username) return; // leaders don't suggest to themselves

    // Broadcast suggestion only to the leader
    const leaderSocket = this.getSocketForUser(leader);
    if (leaderSocket) {
      leaderSocket.send(JSON.stringify({
        type: "suggestion",
        from: username,
        suggestionType: data.suggestionType,
        value: data.value,
      }));
    }
  }

  async handleTeamChat(ws, username, message, room) {
    if (room.gameMode !== "team") {
      ws.send(JSON.stringify({ type: "error", message: "Team Chat is only available in Team Battle." }));
      return;
    }
    const myTeam = ["A", "B"].find(t => room.teams[t]?.members.includes(username));
    if (!myTeam) {
      ws.send(JSON.stringify({ type: "error", message: "You must be on a team to use Team Chat." }));
      return;
    }
    // Team Chat is available during word selection and gameplay; not before teams are formed.
    if (!["words", "playing"].includes(room.phase)) {
      ws.send(JSON.stringify({ type: "error", message: "Team Chat is not available right now." }));
      return;
    }
    // During word selection, lock chat once team word has been submitted.
    if (room.phase === "words" && room.teams[myTeam].secretWord) {
      ws.send(JSON.stringify({ type: "error", message: "Team Chat is locked — the word has been submitted." }));
      return;
    }

    const text = typeof message === "string" ? message.trim().slice(0, 300) : "";
    if (!text) return;

    // Only teammates can see this message.
    room.teams[myTeam].members.forEach(m => {
      const sock = this.getSocketForUser(m);
      if (sock) {
        sock.send(JSON.stringify({ type: "teamChatMessage", from: username, message: text, ts: Date.now() }));
      }
    });
  }

  async handleGlobalChat(ws, username, message, room) {
    if (room.gameMode !== "team") {
      ws.send(JSON.stringify({ type: "error", message: "Global Chat is only available in Team Battle." }));
      return;
    }
    // Global Chat is only available once gameplay starts.
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "Global Chat is only available during gameplay." }));
      return;
    }
    const text = typeof message === "string" ? message.trim().slice(0, 300) : "";
    if (!text) return;

    // Broadcast to all players in the room.
    this.broadcast(room, { type: "globalChatMessage", from: username, message: text, ts: Date.now() });
  }

  // Team Battle: flip to the other team's turn. Falls back to any current
  // member of that team (and repairs the stored leader) if the leader is
  // somehow missing, so the turn can never get permanently stuck on one team.
  advanceTeamTurn(room) {
    const currentTeam = room.teamTurn || "A";
    const otherTeam = currentTeam === "A" ? "B" : "A";
    room.teamTurn = otherTeam;

    let leader = room.teams[otherTeam]?.leader;
    if (!leader || !room.teams[otherTeam].members.includes(leader)) {
      leader = room.teams[otherTeam]?.members?.[0] || null;
      if (room.teams[otherTeam]) room.teams[otherTeam].leader = leader;
    }
    room.currentTurn = leader;
  }

  async handleEndTurn(ws, username, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "Game is not in progress." }));
      return;
    }

    if (room.gameMode === "team") {
      // In team mode, only the active team's leader can end the turn.
      const myTeam = ["A", "B"].find(t => room.teams[t]?.members.includes(username));
      if (!myTeam || room.teamTurn !== myTeam) {
        ws.send(JSON.stringify({ type: "error", message: "It's not your team's turn." }));
        return;
      }
      if (room.teams[myTeam].leader !== username) {
        ws.send(JSON.stringify({ type: "error", message: "Only the team leader can end the turn." }));
        return;
      }
      // Ensure currentTurn is synchronized with the active leader before advancing
      room.currentTurn = username;
    } else {
      if (room.currentTurn !== username) {
        ws.send(JSON.stringify({ type: "error", message: "It's not your turn." }));
        return;
      }
    }

    if (room.gameMode === "team") {
      this.advanceTeamTurn(room);
    } else {
      room.currentTurn = getNextPlayer(room);
    }

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleSubmitWord(ws, username, word, room) {
    if (room.phase !== "words") {
      ws.send(JSON.stringify({ type: "error", message: "Not in the word submission phase." }));
      return;
    }

    const player = room.players.find((p) => p.username === username);
    if (!player) { ws.send(JSON.stringify({ type: "error", message: "Player not found." })); return; }

    if (!word || !word.trim()) { ws.send(JSON.stringify({ type: "error", message: "Your secret word cannot be empty." })); return; }

    const cleaned = word.trim().toUpperCase();

    if (cleaned.length !== room.wordLength) {
      ws.send(JSON.stringify({ type: "error", message: `Your word must be exactly ${room.wordLength} letters.` }));
      return;
    }

    if (!/^[A-Z]+$/.test(cleaned)) {
      ws.send(JSON.stringify({ type: "error", message: "Your word must contain only letters." }));
      return;
    }

    if (room.gameMode === "team") {
      // Team Battle: only ONE secret word per team, and only the team leader may submit it.
      const myTeam = ["A", "B"].find(t => room.teams[t]?.members.includes(username));
      if (!myTeam) { ws.send(JSON.stringify({ type: "error", message: "You must be on a team first." })); return; }
      if (room.teams[myTeam].leader !== username) {
        ws.send(JSON.stringify({ type: "error", message: "Only your Team Leader can submit the secret word." }));
        return;
      }
      if (room.teams[myTeam].secretWord) {
        ws.send(JSON.stringify({ type: "error", message: "Your team's word has already been submitted." }));
        return;
      }

      const revealed = "_".repeat(cleaned.length).split("");
      room.teams[myTeam].secretWord = cleaned;
      room.teams[myTeam].members.forEach(m => {
        const p = room.players.find(pl => pl.username === m);
        if (p) {
          p.secretWord = cleaned;
          p.ready = true;
          p.revealedWord = revealed.slice();
        }
      });

      await this.saveState(room);
      ws.send(JSON.stringify({ type: "wordAccepted" }));

      // Make sure every teammate (not just the leader) knows the shared word
      // and that their team chat is now locked.
      room.teams[myTeam].members.forEach(m => {
        const sock = this.getSocketForUser(m);
        if (sock) sock.send(JSON.stringify({ type: "teamWordSet", word: cleaned }));
      });

      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
      await this.maybeAdvanceFromWords(room);
      return;
    }

    player.secretWord = cleaned;
    player.ready = true;
    player.revealedWord = "_".repeat(cleaned.length).split("");

    await this.saveState(room);
    ws.send(JSON.stringify({ type: "wordAccepted" }));
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    await this.maybeAdvanceFromWords(room);
  }

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
      room.winner = null; room.winnerWord = null; room.endReason = "abandoned";
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
      return;
    }

    room.phase = "playing";
    room.wrongLetters = {};
    room.usedLetters = {};
    room.players.forEach((p) => {
      room.wrongLetters[p.username] = [];
      room.usedLetters[p.username] = [];
    });
    room.winner = null; room.winnerWord = null; room.endReason = null;

    if (room.gameMode === "team") {
      room.teamTurn = "A";
      room.currentTurn = room.teams.A.leader;
    } else {
      room.currentTurn = room.players[0].username;
    }

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleAskLetter(ws, username, letter, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "The game is not currently in progress." }));
      return;
    }

    if (room.gameMode === "team") {
      // In team mode, only the active team's leader may ask a letter.
      const myTeam = ["A", "B"].find(t => room.teams[t]?.members.includes(username));
      if (!myTeam || room.teamTurn !== myTeam) {
        ws.send(JSON.stringify({ type: "error", message: "It's not your team's turn." }));
        return;
      }
      if (room.teams[myTeam].leader !== username) {
        ws.send(JSON.stringify({ type: "error", message: "Only the team leader can ask letters." }));
        return;
      }
      // Keep currentTurn in sync with the acting leader.
      room.currentTurn = username;
    } else {
      if (room.currentTurn !== username) {
        ws.send(JSON.stringify({ type: "error", message: "It's not your turn." }));
        return;
      }
    }

    if (!letter || letter.length !== 1 || !/^[A-Za-z]$/.test(letter)) {
      ws.send(JSON.stringify({ type: "error", message: "Enter a single letter (A–Z)." }));
      return;
    }

    const L = letter.toUpperCase();
    const target = getTargetPlayer(room, username);
    if (!target) { ws.send(JSON.stringify({ type: "error", message: "No target player found." })); return; }

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
        if (secretWord[i] === L) target.revealedWord[i] = L;
      }
      if (room.gameMode === "team") this.syncTeamWordState(room, target.username);
      if (!target.revealedWord.includes("_")) {
        room.winner = username;
        room.winnerWord = secretWord;
        room.phase = "ended";
        room.endReason = "win";
        if (room.gameMode === "team") {
          // Winner is the whole team
          const winnerTeam = ["A", "B"].find(t => room.teams[t].members.includes(username));
          room.winnerTeam = winnerTeam || null;
        }
        await this.saveState(room);
        this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
        return;
      }
    } else {
      if (!room.wrongLetters[target.username]) room.wrongLetters[target.username] = [];
      room.wrongLetters[target.username].push(L);
      if (room.gameMode === "team") this.syncTeamWordState(room, target.username);
    }

    this.broadcast(room, { type: "letterResult", asker: username, target: target.username, letter: L, found });

    if (room.gameMode === "team") {
      // Stay on same team's leader after a letter ask (turn passes after explicit end or guess)
      // (leader keeps going until they end turn)
    } else {
      room.currentTurn = getNextPlayer(room);
    }

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  async handleGuessWord(ws, username, word, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "The game is not currently in progress." }));
      return;
    }

    if (room.gameMode === "team") {
      // In team mode, only the active team's leader may guess.
      const myTeam = ["A", "B"].find(t => room.teams[t]?.members.includes(username));
      if (!myTeam || room.teamTurn !== myTeam) {
        ws.send(JSON.stringify({ type: "error", message: "It's not your team's turn." }));
        return;
      }
      if (room.teams[myTeam].leader !== username) {
        ws.send(JSON.stringify({ type: "error", message: "Only the team leader can guess the word." }));
        return;
      }
      room.currentTurn = username;
    } else {
      if (room.currentTurn !== username) {
        ws.send(JSON.stringify({ type: "error", message: "It's not your turn." }));
        return;
      }
    }

    if (!word || !word.trim()) { ws.send(JSON.stringify({ type: "error", message: "Enter a word to guess." })); return; }

    const guess = word.trim().toUpperCase();
    const target = getTargetPlayer(room, username);
    if (!target) { ws.send(JSON.stringify({ type: "error", message: "No target player found." })); return; }

    if (guess === target.secretWord) {
      room.winner = username;
      room.winnerWord = target.secretWord;
      room.phase = "ended";
      room.endReason = "win";
      if (room.gameMode === "team") {
        const winnerTeam = ["A", "B"].find(t => room.teams[t].members.includes(username));
        room.winnerTeam = winnerTeam || null;
      }
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    } else {
      this.broadcast(room, { type: "wrongGuess", guesser: username, guess });
      // Wrong guess = pass turn
      if (room.gameMode === "team") {
        this.advanceTeamTurn(room);
      } else {
        room.currentTurn = getNextPlayer(room);
      }
      await this.saveState(room);
      this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
    }
  }

  async handleReaction(ws, username, emoji, room) {
    if (room.phase !== "playing") {
      ws.send(JSON.stringify({ type: "error", message: "Reactions are only available during gameplay." }));
      return;
    }
    if (!ALLOWED_REACTION_EMOJIS.includes(emoji)) {
      ws.send(JSON.stringify({ type: "error", message: "That reaction isn't available." }));
      return;
    }

    const now = Date.now();
    const last = this.lastReactionAt.get(username) || 0;
    if (now - last < REACTION_COOLDOWN_MS) {
      return; // within cooldown — silently ignore to prevent spam
    }
    this.lastReactionAt.set(username, now);

    // Works the same in Classic and Team Battle: every connected player sees it.
    this.broadcast(room, { type: "reaction", from: username, emoji });
  }

  async handlePlayAgain(ws, username, room) {
    if (room.host !== username) {
      ws.send(JSON.stringify({ type: "error", message: "Only the host can restart the game." }));
      return;
    }

    room.phase = "lobby";
    room.players.forEach((p) => { p.ready = false; p.secretWord = null; p.revealedWord = null; });
    room.currentTurn = null;
    room.winner = null;
    room.winnerWord = null;
    room.winnerTeam = null;
    room.endReason = null;
    room.wrongLetters = {};
    room.usedLetters = {};
    room.teams = { A: { members: [], leader: null }, B: { members: [], leader: null } };
    room.teamTurn = null;

    await this.saveState(room);
    this.broadcast(room, { type: "state", room: sanitizeRoom(room) });
  }

  // --- Utilities ---

  broadcast(room, message) {
    const str = JSON.stringify(message);
    const playerNames = new Set(room.players.map((p) => p.username));
    for (const ws of this.state.getWebSockets()) {
      try {
        const tags = this.state.getTags(ws);
        if (playerNames.has(tags[1])) ws.send(str);
      } catch {}
    }
  }

  getSocketForUser(username) {
    for (const ws of this.state.getWebSockets()) {
      try {
        const tags = this.state.getTags(ws);
        if (tags[1] === username) return ws;
      } catch {}
    }
    return null;
  }

  // Team Battle: every member of a team shares the same single secret word.
  // After any update to one member's revealedWord/usedLetters/wrongLetters
  // (the "source"), copy that state onto the rest of the team so all
  // teammates' player records stay identical.
  syncTeamWordState(room, sourceUsername) {
    const team = ["A", "B"].find(t => room.teams[t]?.members.includes(sourceUsername));
    if (!team) return;
    const source = room.players.find(p => p.username === sourceUsername);
    if (!source) return;

    const revealed = source.revealedWord ? source.revealedWord.slice() : null;
    const used = (room.usedLetters[sourceUsername] || []).slice();
    const wrong = (room.wrongLetters[sourceUsername] || []).slice();

    room.teams[team].members.forEach(m => {
      if (m === sourceUsername) return;
      const p = room.players.find(pl => pl.username === m);
      if (p && revealed) p.revealedWord = revealed.slice();
      room.usedLetters[m] = used.slice();
      room.wrongLetters[m] = wrong.slice();
    });
  }
}

// =============================================================
// Helpers
// =============================================================

function createEmptyRoom(code, wordLength, gameMode = "classic") {
  return {
    code,
    wordLength: parseInt(wordLength, 10),
    phase: "lobby",
    host: null,
    players: [],
    currentTurn: null,
    wrongLetters: {},
    usedLetters: {},
    winner: null,
    winnerWord: null,
    winnerTeam: null,
    endReason: null,
    gameMode,
    teams: { A: { members: [], leader: null }, B: { members: [], leader: null } },
    teamTurn: null,
  };
}

function sanitizeRoom(room) {
  const teams = room.teams ? {
    A: {
      members: room.teams.A.members,
      leader: room.teams.A.leader,
      hasWord: !!room.teams.A.secretWord,
      secretWord: room.phase === "ended" ? (room.teams.A.secretWord || null) : null,
    },
    B: {
      members: room.teams.B.members,
      leader: room.teams.B.leader,
      hasWord: !!room.teams.B.secretWord,
      secretWord: room.phase === "ended" ? (room.teams.B.secretWord || null) : null,
    },
  } : room.teams;

  return {
    code: room.code,
    wordLength: room.wordLength,
    phase: room.phase,
    host: room.host,
    currentTurn: room.currentTurn,
    winner: room.winner,
    winnerWord: room.phase === "ended" ? room.winnerWord : null,
    winnerTeam: room.winnerTeam || null,
    endReason: room.endReason,
    wrongLetters: room.wrongLetters,
    gameMode: room.gameMode,
    teams,
    teamTurn: room.teamTurn,
    players: room.players.map((p) => ({
      username: p.username,
      isHost: p.isHost,
      ready: p.ready,
      revealedWord: p.revealedWord,
      hasWord: !!p.secretWord,
      word: room.phase === "ended" ? (p.secretWord || null) : null,
    })),
  };
}

// Team Leader rule: a team with exactly one player automatically has that
// player as leader. Once a second player joins, the existing leader is left
// in place (teammates can change it via "setLeader"). If a team becomes
// empty, or its leader leaves, the leader is cleared/reassigned accordingly.
function maybeAutoAssignLeader(room, team) {
  const t = room.teams[team];
  if (!t) return;
  if (t.members.length === 1) {
    t.leader = t.members[0];
  } else if (t.members.length === 0) {
    t.leader = null;
  } else if (t.leader && !t.members.includes(t.leader)) {
    t.leader = null;
  }
}

function getNextPlayer(room) {
  const activePlayers = room.players;
  if (!activePlayers.length) return null;
  const idx = activePlayers.findIndex((p) => p.username === room.currentTurn);
  return activePlayers[(idx + 1) % activePlayers.length].username;
}

function getTargetPlayer(room, currentUsername) {
  if (room.gameMode === "team") {
    // The leader's target is a member of the opposing team
    const myTeam = ["A", "B"].find(t => room.teams[t].members.includes(currentUsername));
    if (!myTeam) return null;
    const enemyTeam = myTeam === "A" ? "B" : "A";
    // Target is first member of enemy team who still has a secret word (not fully revealed)
    const enemyMembers = room.teams[enemyTeam].members;
    const enemyPlayer = room.players.find(p =>
      enemyMembers.includes(p.username) && p.revealedWord && p.revealedWord.includes("_")
    );
    return enemyPlayer || room.players.find(p => enemyMembers.includes(p.username)) || null;
  }
  const players = room.players;
  const idx = players.findIndex((p) => p.username === currentUsername);
  if (idx === -1) return null;
  return players[(idx + 1) % players.length];
}