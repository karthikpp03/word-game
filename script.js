// =============================================================
// WordGuess – Frontend Client
// =============================================================

// ── Config ──────────────────────────────────────────────────
// Replace with your deployed Worker URL after deploying
const WORKER_URL = "https://wordgame-worker.<YOUR_SUBDOMAIN>.workers.dev";

// =============================================================
// State
// =============================================================
const state = {
  username: "",
  roomCode: "",
  room: null,         // Latest room state from server
  ws: null,           // Active WebSocket connection
  countdownTimer: null,
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
  toastTimeout = setTimeout(() => {
    el.classList.remove("show");
  }, duration);
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
  // Show create form (word length picker)
  $("join-form").classList.add("hidden");
  $("create-form").classList.toggle("hidden");
});

$("btn-join-show").addEventListener("click", () => {
  const username = $("home-username").value.trim();
  if (!username) { toast("Enter a username", "error"); return; }
  // Show join form
  $("create-form").classList.add("hidden");
  $("join-form").classList.toggle("hidden");
});

$("btn-create-confirm").addEventListener("click", async () => {
  const username = $("home-username").value.trim();
  const wordLength = parseInt($("word-length").value);

  if (!username) { toast("Enter a username", "error"); return; }

  try {
    const res = await fetch(`${WORKER_URL}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, wordLength }),
    });

    const data = await res.json();

    if (!res.ok) {
      toast(data.error || "Failed to create room", "error");
      return;
    }

    state.username = username;
    state.roomCode = data.roomCode;
    connectWebSocket();
  } catch (err) {
    toast("Could not reach server. Check WORKER_URL in script.js.", "error");
    console.error(err);
  }
});

$("btn-join").addEventListener("click", () => {
  const username = $("home-username").value.trim();
  const code = $("join-code").value.trim();

  if (!username) { toast("Enter a username", "error"); return; }
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    toast("Enter a valid 6-digit room code", "error");
    return;
  }

  state.username = username;
  state.roomCode = code;
  connectWebSocket();
});

// Allow Enter key on join code input
$("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-join").click();
});

// =============================================================
// WebSocket Connection
// =============================================================
function connectWebSocket() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  const wsUrl = WORKER_URL.replace(/^https?/, "wss")
    + `/room/${state.roomCode}?username=${encodeURIComponent(state.username)}`;

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
    // Attempt reconnect after 2s if game is still in progress
    if (state.roomCode) {
      setTimeout(() => {
        if (state.roomCode) connectWebSocket();
      }, 2000);
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
      toast(`${msg.guesser} guessed "${msg.guess}" – Wrong!`, "error");
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
    case "lobby":
      renderLobby();
      break;
    case "words":
      renderWords();
      break;
    case "countdown":
      renderCountdown();
      break;
    case "playing":
      renderPlaying();
      break;
    case "ended":
      renderEnded();
      break;
  }
}

// =============================================================
// Lobby Screen
// =============================================================
function renderLobby() {
  showScreen("lobby");
  const room = state.room;

  $("lobby-code").textContent = room.code;

  // Build player list
  const list = $("lobby-players");
  list.innerHTML = "";
  room.players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player-item";
    div.innerHTML = `
      <span>${p.username}</span>
      ${p.isHost ? `<span class="badge badge-host">Host</span>` : ""}
      ${p.username === state.username ? `<span class="badge badge-you">You</span>` : ""}
    `;
    list.appendChild(div);
  });

  // Show / hide Start button
  const isHost = room.host === state.username;
  const canStart = room.players.length >= 2;
  const startBtn = $("btn-start");
  const waitingMsg = $("lobby-waiting");

  if (isHost) {
    startBtn.classList.remove("hidden");
    waitingMsg.classList.add("hidden");
    startBtn.disabled = !canStart;
    startBtn.title = canStart ? "" : "Need at least 2 players";
  } else {
    startBtn.classList.add("hidden");
    waitingMsg.classList.remove("hidden");
  }
}

$("btn-copy-code").addEventListener("click", () => {
  const code = $("lobby-code").textContent;
  navigator.clipboard.writeText(code).then(() => toast("Room code copied!", "success"));
});

$("btn-start").addEventListener("click", () => {
  send({ type: "startGame" });
});

// =============================================================
// Word Submission Screen
// =============================================================
function renderWords() {
  showScreen("words");
  const room = state.room;

  $("word-length-hint").textContent =
    `Enter a secret word that is exactly ${room.wordLength} letters long. Only you will see it.`;

  // Show player ready status
  const list = $("words-player-list");
  list.innerHTML = "";
  room.players.forEach((p) => {
    const div = document.createElement("div");
    div.className = "player-item";
    div.innerHTML = `
      <span>${p.username}</span>
      ${p.username === state.username ? `<span class="badge badge-you">You</span>` : ""}
      <span class="badge ${p.ready ? "badge-ready" : "badge-waiting"}">
        ${p.ready ? "Ready" : "Waiting"}
      </span>
    `;
    list.appendChild(div);
  });

  // Find myself
  const me = room.players.find((p) => p.username === state.username);
  if (me && me.ready) {
    $("secret-word-input").disabled = true;
    $("btn-ready").disabled = true;
    $("btn-ready").textContent = "Waiting for others…";
  } else {
    $("secret-word-input").disabled = false;
    $("btn-ready").disabled = false;
    $("btn-ready").textContent = "Ready";
  }
}

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
      $("countdown-number").textContent = n;
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
  const isMyTurn = room.currentTurn === state.username;

  // Turn banner
  $("turn-label").textContent = isMyTurn
    ? "Your turn!"
    : `${room.currentTurn}'s turn`;

  // Find who I am and who the target is (next player)
  const players = room.players;
  const myIdx = players.findIndex((p) => p.username === state.username);
  const targetIdx = (myIdx + 1) % players.length;
  const target = players[targetIdx];

  // Show the target player's revealed word (what I'm guessing)
  const guessingPlayer = players[(players.findIndex(
    (p) => p.username === room.currentTurn) + 1) % players.length];

  $("target-label").textContent = `(${guessingPlayer?.username}'s word)`;
  renderHiddenWord(guessingPlayer?.revealedWord || []);

  // Wrong letters for the target's word
  const wrongLetters = room.wrongLetters?.[guessingPlayer?.username] || [];
  renderWrongLetters(wrongLetters);

  // My own word (always visible to me)
  const me = players.find((p) => p.username === state.username);
  renderOwnWord(me?.revealedWord || []);

  // Show controls only on my turn
  if (isMyTurn) {
    $("controls").classList.remove("hidden");
    $("waiting-turn").classList.add("hidden");
    $("letter-input").focus();
  } else {
    $("controls").classList.add("hidden");
    $("waiting-turn").classList.remove("hidden");
  }
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
  if (!revealedWord || revealedWord.length === 0) return;
  revealedWord.forEach((ch, i) => {
    const box = document.createElement("div");
    box.className = "own-letter";
    // For your own word, show the real letters if available
    // The server sends revealedWord which starts masked, but for the owner
    // we want to show their actual word — so we stored it locally on submission
    box.textContent = state.mySecretWord ? state.mySecretWord[i] : (ch !== "_" ? ch : "_");
    container.appendChild(box);
  });
}

// Track own word locally to always display it
$("btn-ready").addEventListener("click", () => {
  // Capture word before sending
  const word = $("secret-word-input").value.trim().toUpperCase();
  if (word) state.mySecretWord = word;
}, true); // capture phase so it runs before the other listener

// Ask Letter
$("btn-ask").addEventListener("click", () => {
  const letter = $("letter-input").value.trim();
  if (!letter) { toast("Enter a letter", "error"); return; }
  if (!/^[A-Za-z]$/.test(letter)) { toast("Only single letters allowed", "error"); return; }
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

// =============================================================
// Letter Result
// =============================================================
function handleLetterResult(msg) {
  if (msg.found) {
    toast(`"${msg.letter}" found in ${msg.target}'s word!`, "success");
  } else {
    toast(`"${msg.letter}" not in ${msg.target}'s word.`, "error");
  }
}

// =============================================================
// End Screen
// =============================================================
function renderEnded() {
  clearInterval(countdownInterval);
  showScreen("ended");
  const room = state.room;

  $("winner-name").textContent = room.winner === state.username
    ? "You won! 🎉"
    : `${room.winner} won!`;

  $("winner-word").textContent = room.winnerWord || "";

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