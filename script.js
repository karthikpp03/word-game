// =============================================================
// WordGuess – Frontend Client
// =============================================================

const WORKER_URL = "https://word-game.zeus-karthik11.workers.dev";

// =============================================================
// State
// =============================================================
const state = {
  username: "",
  roomCode: "",
  room: null,
  ws: null,
  mySecretWord: null,
  countdownTimer: null,
  pendingSuggestion: null,   // { from, suggestionType, value }
};

// =============================================================
// Screen Management
// =============================================================
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(`screen-${id}`).classList.add("active");
}

// =============================================================
// Toast notifications
// =============================================================
let toastTimeout = null;
function toast(message, type = "", duration = 3000) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove("show"), duration);
}

// =============================================================
// DOM helpers
// =============================================================
const $ = (id) => document.getElementById(id);

// =============================================================
// Home Screen
// =============================================================
$("btn-create").addEventListener("click", () => {
  const username = $("home-username").value.trim();
  if (!username) { toast("Enter a username", "error"); return; }
  $("join-form").classList.add("hidden");
  $("create-form").classList.toggle("hidden");
});

$("btn-join-show").addEventListener("click", () => {
  const username = $("home-username").value.trim();
  if (!username) { toast("Enter a username", "error"); return; }
  $("create-form").classList.add("hidden");
  $("join-form").classList.toggle("hidden");
});

$("btn-create-confirm").addEventListener("click", async () => {
  const username = $("home-username").value.trim();
  const wordLength = parseInt($("word-length").value);
  const gameMode = document.querySelector('input[name="game-mode"]:checked')?.value || "classic";
  if (!username) { toast("Enter a username", "error"); return; }

  const btn = $("btn-create-confirm");
  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    const res = await fetch(`${WORKER_URL}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, wordLength, gameMode }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || "Failed to create room", "error"); return; }
    state.username = username;
    state.roomCode = data.roomCode;
    connectWebSocket();
  } catch (err) {
    toast("Could not reach server. Check WORKER_URL in script.js.", "error");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Create & Enter Lobby";
  }
});

$("btn-join").addEventListener("click", () => {
  const username = $("home-username").value.trim();
  const code = $("join-code").value.trim();
  if (!username) { toast("Enter a username", "error"); return; }
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    toast("Enter a valid 6-digit room code", "error"); return;
  }
  state.username = username;
  state.roomCode = code;
  connectWebSocket();
});

$("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-join").click();
});

// =============================================================
// WebSocket Connection
// =============================================================
function connectWebSocket() {
  if (state.ws) { state.ws.close(); state.ws = null; }

  let clientId = localStorage.getItem("clientId");
  if (!clientId) {
    clientId = crypto.randomUUID();
    localStorage.setItem("clientId", clientId);
  }

  const wsUrl =
    WORKER_URL.replace(/^https?/, "wss") +
    `/room/${state.roomCode}?username=${encodeURIComponent(state.username)}&id=${encodeURIComponent(clientId)}`;

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "join" }));
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener("close", () => {
    if (state.roomCode) {
      toast("Connection lost. Reconnecting…", "error");
      setTimeout(() => { if (state.roomCode) connectWebSocket(); }, 2000);
    }
  });

  ws.addEventListener("error", () => {
    toast("Connection error. Retrying…", "error");
  });
}

// =============================================================
// Message Handler
// =============================================================
function handleMessage(msg) {
  switch (msg.type) {
    case "joined":
      state.room = msg.room;
      if (msg.yourWord) state.mySecretWord = msg.yourWord;
      renderCurrentPhase();
      break;

    case "state":
      state.room = msg.room;
      renderCurrentPhase();
      break;

    case "letterResult":
      handleLetterResult(msg);
      break;

    case "wrongGuess":
      toast(`❌  "${msg.guess}" is wrong — ${msg.guesser} keeps trying!`, "error");
      break;

    case "suggestion":
      showSuggestionPopup(msg);
      break;

    case "error":
      toast(msg.message, "error");
      break;
  }
}

// =============================================================
// Phase Router
// =============================================================
function renderCurrentPhase() {
  const room = state.room;
  if (!room) return;
  switch (room.phase) {
    case "lobby":     renderLobby();     break;
    case "teams":     renderTeams();     break;
    case "words":     renderWords();     break;
    case "countdown": renderCountdown(); break;
    case "playing":   renderPlaying();   break;
    case "ended":     renderEnded();     break;
  }
}

// =============================================================
// Lobby Screen
// =============================================================
function renderLobby() {
  showScreen("lobby");
  const room = state.room;

  $("lobby-code").textContent = room.code;

  // Show mode badge
  const modeBadge = $("lobby-mode-badge");
  if (room.gameMode === "team") {
    modeBadge.textContent = "⚔️ Team Battle Mode";
    modeBadge.classList.remove("hidden");
  } else {
    modeBadge.classList.add("hidden");
  }

  const list = $("lobby-players");
  list.innerHTML = "";
  room.players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player-item";
    const initials = p.username.slice(0, 2).toUpperCase();
    div.innerHTML = `
      <div class="player-avatar">${initials}</div>
      <span class="player-name">${p.username}</span>
      ${p.isHost ? `<span class="badge badge-host">Host</span>` : ""}
      ${p.username === state.username ? `<span class="badge badge-you">You</span>` : ""}
    `;
    list.appendChild(div);
  });

  const isHost = room.host === state.username;
  const canStart = room.players.length >= 2;
  const startBtn = $("btn-start");
  const waitingMsg = $("lobby-waiting");

  if (isHost) {
    startBtn.classList.remove("hidden");
    waitingMsg.classList.add("hidden");
    startBtn.disabled = !canStart;
    startBtn.textContent = canStart
      ? "Start Game"
      : `Waiting for players… (${room.players.length}/2)`;
  } else {
    startBtn.classList.add("hidden");
    waitingMsg.classList.remove("hidden");
    waitingMsg.textContent = `Waiting for host to start… (${room.players.length} player${room.players.length !== 1 ? "s" : ""})`;
  }
}

$("btn-copy-code").addEventListener("click", () => {
  const code = $("lobby-code").textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = $("btn-copy-code");
    btn.classList.add("copied");
    btn.querySelector(".copy-text").textContent = "Copied!";
    btn.querySelector(".copy-icon").textContent = "✓";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.querySelector(".copy-text").textContent = "Copy";
      btn.querySelector(".copy-icon").textContent = "📋";
    }, 2000);
  });
});

$("btn-start").addEventListener("click", () => {
  send({ type: "startGame" });
});

// =============================================================
// Team Selection Screen
// =============================================================
function renderTeams() {
  showScreen("teams");
  const room = state.room;
  const teams = room.teams || { A: { members: [], leader: null }, B: { members: [], leader: null } };
  const myTeam = ["A", "B"].find(t => teams[t].members.includes(state.username)) || null;

  // Render each team
  ["A", "B"].forEach(t => {
    const listEl = $(`team-${t.toLowerCase()}-players`);
    const leaderRow = $(`team-${t.toLowerCase()}-leader-row`);
    const leaderName = $(`team-${t.toLowerCase()}-leader-name`);
    listEl.innerHTML = "";

    teams[t].members.forEach(member => {
      const isLeader = teams[t].leader === member;
      const isMe = member === state.username;
      const div = document.createElement("div");
      div.className = "team-player-item";
      div.innerHTML = `
        <span class="team-player-avatar">${isLeader ? "👑" : "👤"}</span>
        <span class="team-player-name${isLeader ? " is-leader" : ""}">${member}${isMe ? " (You)" : ""}</span>
        ${myTeam === t && !isMe ? `<button class="btn btn-set-leader btn-xs" data-target="${member}" data-team="${t}">Set Leader</button>` : ""}
      `;
      listEl.appendChild(div);
    });

    if (teams[t].members.length === 0) {
      listEl.innerHTML = `<div class="team-empty">No players yet</div>`;
    }

    if (teams[t].leader) {
      leaderRow.classList.remove("hidden");
      leaderName.textContent = teams[t].leader;
    } else {
      leaderRow.classList.add("hidden");
    }
  });

  // "Set Leader" button handlers (delegated)
  document.querySelectorAll(".btn-set-leader").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      send({ type: "setLeader", target });
    });
  });

  // Join team buttons
  const joinA = $("btn-join-team-a");
  const joinB = $("btn-join-team-b");

  joinA.textContent = myTeam === "A" ? "✓ On Team A" : "Join Team A";
  joinB.textContent = myTeam === "B" ? "✓ On Team B" : "Join Team B";
  joinA.classList.toggle("active-team", myTeam === "A");
  joinB.classList.toggle("active-team", myTeam === "B");

  // Host controls
  const isHost = room.host === state.username;
  $("teams-host-controls").classList.toggle("hidden", !isHost);
  $("teams-waiting-msg").classList.toggle("hidden", isHost);

  if (isHost) {
    const { canStart, reason } = getTeamStartValidation(room);
    const startBtn = $("btn-teams-start");
    startBtn.disabled = !canStart;
    $("teams-start-reason").textContent = canStart ? "" : reason;
    $("teams-start-reason").classList.toggle("hidden", canStart);
  }
}

function getTeamStartValidation(room) {
  const teams = room.teams || {};
  const allPlayers = room.players.map(p => p.username);

  const assignedPlayers = [
    ...(teams.A?.members || []),
    ...(teams.B?.members || []),
  ];
  const unassigned = allPlayers.filter(p => !assignedPlayers.includes(p));

  if (unassigned.length > 0) {
    return { canStart: false, reason: `Waiting for all players to join a team…` };
  }
  if ((teams.A?.members || []).length === 0) {
    return { canStart: false, reason: "Waiting for Team A…" };
  }
  if ((teams.B?.members || []).length === 0) {
    return { canStart: false, reason: "Waiting for Team B…" };
  }
  if (!teams.A?.leader) {
    return { canStart: false, reason: "Waiting for Team A Leader…" };
  }
  if (!teams.B?.leader) {
    return { canStart: false, reason: "Waiting for Team B Leader…" };
  }
  return { canStart: true, reason: "" };
}

$("btn-join-team-a").addEventListener("click", () => {
  send({ type: "joinTeam", team: "A" });
});

$("btn-join-team-b").addEventListener("click", () => {
  send({ type: "joinTeam", team: "B" });
});

$("btn-teams-start").addEventListener("click", () => {
  send({ type: "startTeamGame" });
});

// =============================================================
// Word Submission Screen
// =============================================================
function renderWords() {
  showScreen("words");
  const room = state.room;

  $("word-length-hint").textContent =
    `Choose a secret word that is exactly ${room.wordLength} letters long. Your opponent must guess it.`;

  const list = $("words-player-list");
  list.innerHTML = "";
  room.players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player-item";
    const initials = p.username.slice(0, 2).toUpperCase();
    div.innerHTML = `
      <div class="player-avatar">${initials}</div>
      <span class="player-name">${p.username}</span>
      ${p.username === state.username ? `<span class="badge badge-you">You</span>` : ""}
      <span class="badge ${p.ready ? "badge-ready" : "badge-waiting"}">
        ${p.ready ? "Ready ✓" : "Choosing…"}
      </span>
    `;
    list.appendChild(div);
  });

  const me = room.players.find((p) => p.username === state.username);
  if (me && me.ready) {
    $("secret-word-input").disabled = true;
    $("btn-ready").disabled = true;
    $("btn-ready").textContent = "Waiting for others…";
  } else {
    $("secret-word-input").disabled = false;
    $("btn-ready").disabled = false;
    $("btn-ready").textContent = "I'm Ready";
  }
}

$("btn-ready").addEventListener("click", () => {
  const word = $("secret-word-input").value.trim().toUpperCase();
  if (word) state.mySecretWord = word;
}, true);

$("btn-ready").addEventListener("click", () => {
  const word = $("secret-word-input").value.trim();
  if (!word) { toast("Enter your secret word", "error"); return; }
  send({ type: "submitWord", word });
});

$("secret-word-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-ready").click();
});

// =============================================================
// Countdown Screen
// =============================================================
let countdownInterval = null;

function renderCountdown() {
  showScreen("countdown");
  let n = 5;
  $("countdown-number").textContent = n;

  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(countdownInterval);
    } else {
      const el = $("countdown-number");
      el.style.animation = "none";
      el.textContent = n;
      requestAnimationFrame(() => { el.style.animation = ""; });
    }
  }, 1000);
}

// =============================================================
// Playing Screen
// =============================================================
function renderPlaying() {
  clearInterval(countdownInterval);
  showScreen("playing");
  const room = state.room;
  const isTeamMode = room.gameMode === "team";
  const isMyTurn = room.currentTurn === state.username;

  // Team status banner
  const teamBanner = $("team-status-banner");
  if (isTeamMode && room.teams) {
    const activeTeam = room.teamTurn;
    const activeLeader = room.teams[activeTeam]?.leader;
    const teamColor = activeTeam === "A" ? "🟦" : "🟥";
    const teamName = `Team ${activeTeam}`;
    const leaderDeciding = isMyTurn
      ? `👑 ${activeLeader} deciding…`
      : `👑 ${activeLeader} deciding…`;
    teamBanner.innerHTML = `
      <span class="team-status-icon">${teamColor}</span>
      <span class="team-status-text"><strong>${teamName} Turn</strong> · ${leaderDeciding}</span>
    `;
    teamBanner.className = `team-status-banner team-status-${activeTeam.toLowerCase()}`;
    teamBanner.classList.remove("hidden");
  } else {
    teamBanner.classList.add("hidden");
  }

  // Turn banner
  const banner = $("turn-banner");
  const label  = $("turn-label");
  if (isMyTurn) {
    banner.className = "turn-banner my-turn";
    label.textContent = "✦ Your turn — make a move!";
  } else {
    banner.className = "turn-banner their-turn";
    label.textContent = `${room.currentTurn} is thinking…`;
  }

  const players = room.players;
  const myIdx = players.findIndex((p) => p.username === state.username);

  // In team mode, target is an enemy player (server picks). For display, find any
  // enemy player with unrevealed letters.
  let myTarget;
  if (isTeamMode && room.teams) {
    const myTeam = ["A", "B"].find(t => room.teams[t].members.includes(state.username));
    const enemyTeam = myTeam === "A" ? "B" : "A";
    const enemyMembers = room.teams[enemyTeam]?.members || [];
    myTarget = players.find(p => enemyMembers.includes(p.username) && p.revealedWord?.includes("_"))
      || players.find(p => enemyMembers.includes(p.username));
  } else {
    myTarget = players[(myIdx + 1) % players.length];
  }

  $("target-label").textContent = myTarget ? myTarget.username : "";
  renderHiddenWord(myTarget?.revealedWord || []);

  const wrongLetters = room.wrongLetters?.[myTarget?.username] || [];
  renderWrongLetters(wrongLetters);

  const me = players[myIdx];
  renderOwnWord(me?.revealedWord || []);

  // Decide what controls to show
  const controls     = $("controls");
  const teammatePanel = $("teammate-panel");
  const waitingTurn  = $("waiting-turn");

  if (isTeamMode) {
    const myTeam = ["A", "B"].find(t => room.teams[t].members.includes(state.username));
    const isLeader = room.teams?.[myTeam]?.leader === state.username;
    const isMyTeamTurn = room.teamTurn === myTeam;

    if (isLeader && isMyTeamTurn) {
      // Leader on their turn — show controls
      controls.classList.remove("hidden");
      teammatePanel.classList.add("hidden");
      waitingTurn.classList.add("hidden");
      $("letter-input").focus();
    } else if (!isLeader) {
      // Non-leader teammate — show suggestion panel
      controls.classList.add("hidden");
      waitingTurn.classList.add("hidden");
      teammatePanel.classList.remove("hidden");
      renderTeammatePanel(room, myTeam);
    } else {
      // Leader but other team's turn
      controls.classList.add("hidden");
      teammatePanel.classList.add("hidden");
      waitingTurn.classList.remove("hidden");
    }
  } else {
    if (isMyTurn) {
      controls.classList.remove("hidden");
      teammatePanel.classList.add("hidden");
      waitingTurn.classList.add("hidden");
      $("letter-input").focus();
    } else {
      controls.classList.add("hidden");
      teammatePanel.classList.add("hidden");
      waitingTurn.classList.remove("hidden");
    }
  }
}

function renderTeammatePanel(room, myTeam) {
  const leaderDisplay = $("teammate-leader-display");
  const leader = room.teams?.[myTeam]?.leader;
  const isMyTeamTurn = room.teamTurn === myTeam;
  leaderDisplay.innerHTML = `
    <div class="teammate-leader-name">
      <span>👑 ${leader || "None"}</span>
    </div>
    <div class="teammate-leader-status ${isMyTeamTurn ? "active" : ""}">
      ${isMyTeamTurn ? "Currently Playing…" : "Waiting for turn…"}
    </div>
  `;
}

function renderHiddenWord(revealedWord) {
  const container = $("hidden-word");
  container.innerHTML = "";
  if (!revealedWord || revealedWord.length === 0) {
    container.textContent = "—";
    return;
  }
  revealedWord.forEach((ch) => {
    const box = document.createElement("div");
    box.className = "letter-box" + (ch !== "_" ? " revealed" : "");
    box.textContent = ch !== "_" ? ch : "";
    container.appendChild(box);
  });
}

function renderWrongLetters(letters) {
  const container = $("wrong-letters");
  container.innerHTML = "";
  if (!letters || letters.length === 0) {
    container.innerHTML = `<span class="no-wrong">None yet</span>`;
    return;
  }
  letters.forEach((l) => {
    const chip = document.createElement("span");
    chip.className = "wrong-chip";
    chip.textContent = l;
    container.appendChild(chip);
  });
}

function renderOwnWord(revealedWord) {
  const container = $("own-word");
  container.innerHTML = "";
  if (!state.mySecretWord && (!revealedWord || revealedWord.length === 0)) return;

  const word = state.mySecretWord || "";
  const length = word.length || (revealedWord ? revealedWord.length : 0);

  for (let i = 0; i < length; i++) {
    const box = document.createElement("div");
    const letter = word[i] || (revealedWord[i] !== "_" ? revealedWord[i] : "?");
    const opponentFound = revealedWord && revealedWord[i] && revealedWord[i] !== "_";
    box.className = "own-letter" + (opponentFound ? " opponent-found" : "");
    box.textContent = letter;
    container.appendChild(box);
  }
}

// Ask Letter
$("btn-ask").addEventListener("click", () => {
  const letter = $("letter-input").value.trim();
  if (!letter) { toast("Enter a letter", "error"); return; }
  if (!/^[A-Za-z]$/.test(letter)) { toast("Single letters only", "error"); return; }
  send({ type: "askLetter", letter });
  $("letter-input").value = "";
  $("letter-input").focus();
});

$("letter-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-ask").click();
});

// Guess Word
$("btn-guess").addEventListener("click", () => {
  const word = $("guess-input").value.trim();
  if (!word) { toast("Enter a word to guess", "error"); return; }
  send({ type: "guessWord", word });
  $("guess-input").value = "";
});

$("guess-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-guess").click();
});

// End Turn (Team Battle leaders)
$("btn-end-turn").addEventListener("click", () => {
  send({ type: "endTurn" });
});

// =============================================================
// Teammate Suggestion Controls
// =============================================================
$("btn-suggest-letter").addEventListener("click", () => {
  const val = $("suggest-letter-input").value.trim();
  if (!val || !/^[A-Za-z]$/.test(val)) { toast("Enter a single letter", "error"); return; }
  send({ type: "suggestAction", suggestionType: "letter", value: val.toUpperCase() });
  $("suggest-letter-input").value = "";
  toast("Suggestion sent!", "info", 1500);
});

$("suggest-letter-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-suggest-letter").click();
});

$("btn-suggest-word").addEventListener("click", () => {
  const val = $("suggest-word-input").value.trim();
  if (!val) { toast("Enter a word to suggest", "error"); return; }
  send({ type: "suggestAction", suggestionType: "word", value: val.toUpperCase() });
  $("suggest-word-input").value = "";
  toast("Suggestion sent!", "info", 1500);
});

$("suggest-word-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-suggest-word").click();
});

// =============================================================
// Suggestion Popup (shown to leader)
// =============================================================
function showSuggestionPopup(msg) {
  state.pendingSuggestion = msg;
  const popup = $("suggestion-popup");
  const title = $("suggestion-popup-title");
  const body  = $("suggestion-popup-body");

  const typeLabel = msg.suggestionType === "letter" ? "Letter" : "Word";
  title.textContent = `${msg.from} suggested a ${typeLabel}`;
  body.innerHTML = `
    <div class="suggestion-value">${msg.value}</div>
  `;

  popup.classList.remove("hidden");
  popup.classList.add("show");
}

$("btn-accept-suggestion").addEventListener("click", () => {
  const s = state.pendingSuggestion;
  if (!s) return;
  if (s.suggestionType === "letter") {
    $("letter-input").value = s.value;
    $("letter-input").focus();
  } else {
    $("guess-input").value = s.value;
    $("guess-input").focus();
  }
  hideSuggestionPopup();
});

$("btn-ignore-suggestion").addEventListener("click", () => {
  hideSuggestionPopup();
});

function hideSuggestionPopup() {
  const popup = $("suggestion-popup");
  popup.classList.remove("show");
  setTimeout(() => popup.classList.add("hidden"), 200);
  state.pendingSuggestion = null;
}

// =============================================================
// Letter Result
// =============================================================
function handleLetterResult(msg) {
  if (msg.found) {
    toast(`✓  "${msg.letter.toUpperCase()}" found in ${msg.target}'s word!`, "success");
  } else {
    toast(`✗  "${msg.letter.toUpperCase()}" is not in ${msg.target}'s word.`, "error");
  }
}

// =============================================================
// End Screen
// =============================================================
function renderEnded() {
  clearInterval(countdownInterval);
  showScreen("ended");
  const room = state.room;
  const isTeamMode = room.gameMode === "team";

  if (isTeamMode && room.winnerTeam) {
    const winTeam = room.winnerTeam;
    const teamMembers = room.teams?.[winTeam]?.members || [];
    const isMyTeam = teamMembers.includes(state.username);

    $("winner-name").textContent = isMyTeam
      ? `🎉 Team ${winTeam} Wins!`
      : `🏆 Team ${winTeam} Wins!`;

    // Show team members
    const memberEl = $("winner-team-members");
    memberEl.innerHTML = "";
    const leader = room.teams?.[winTeam]?.leader;
    teamMembers.forEach(member => {
      const isLeader = member === leader;
      const div = document.createElement("div");
      div.className = "winner-member";
      div.innerHTML = `${isLeader ? "👑" : "👤"} ${member}`;
      memberEl.appendChild(div);
    });
    memberEl.classList.remove("hidden");
  } else {
    const isWinner = room.winner === state.username;
    $("winner-name").textContent = isWinner ? "🎉 You Won!" : `${room.winner} Wins!`;
    $("winner-team-members").classList.add("hidden");
  }

  // Reveal every player's secret word
  const list = $("secret-words-list");
  list.innerHTML = "";

  room.players.forEach((p, idx) => {
    const row = document.createElement("div");
    const isWinner = isTeamMode
      ? (room.teams?.[room.winnerTeam]?.members || []).includes(p.username)
      : p.username === room.winner;
    row.className = "secret-word-row" + (isWinner ? " is-winner" : "");
    row.style.animationDelay = `${idx * 0.08}s`;

    const word = p.word
      || (p.username === state.username ? state.mySecretWord : null)
      || "?".repeat(room.wordLength || 5);
    const initials = p.username.slice(0, 2).toUpperCase();

    // In team mode, show team tag
    let teamTag = "";
    if (isTeamMode && room.teams) {
      const playerTeam = ["A", "B"].find(t => room.teams[t].members.includes(p.username));
      if (playerTeam) {
        teamTag = `<span class="badge badge-team-${playerTeam.toLowerCase()}">${playerTeam === "A" ? "🟦 A" : "🟥 B"}</span>`;
      }
    }

    row.innerHTML = `
      <div class="sw-avatar">${isWinner ? "🏆" : initials}</div>
      <div class="sw-info">
        <div class="sw-username">
          ${p.username}
          ${isWinner ? `<span class="crown">👑</span>` : ""}
          ${p.username === state.username ? `<span class="badge badge-you">You</span>` : ""}
          ${teamTag}
        </div>
        <div class="sw-word">${word}</div>
      </div>
    `;
    list.appendChild(row);
  });

  const isHost = room.host === state.username;
  $("btn-play-again").classList.toggle("hidden", !isHost);
  $("waiting-host").classList.toggle("hidden", isHost);
}

$("btn-play-again").addEventListener("click", () => {
  state.mySecretWord = null;
  $("secret-word-input").value = "";
  send({ type: "playAgain" });
});

// =============================================================
// Send helper
// =============================================================
function send(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  } else {
    toast("Not connected. Reconnecting…", "error");
  }
}
