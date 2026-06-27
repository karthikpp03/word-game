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
  if (!username) { toast("Enter a username", "error"); return; }

  const btn = $("btn-create-confirm");
  btn.disabled = true;
  btn.textContent = "Creating…";

  try {
    const res = await fetch(`${WORKER_URL}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, wordLength }),
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

// Capture word in capture phase before send
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
      // Restart animation by cloning trick
      el.style.animation = "none";
      el.textContent = n;
      requestAnimationFrame(() => {
        el.style.animation = "";
      });
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

  // Turn banner with style based on whose turn it is
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
  const myIdx   = players.findIndex((p) => p.username === state.username);
  const myTarget = players[(myIdx + 1) % players.length];

  // "Word to guess" — always my permanent target
  $("target-label").textContent = myTarget ? myTarget.username : "";
  renderHiddenWord(myTarget?.revealedWord || []);

  // Wrong letters I've guessed against my target
  const wrongLetters = room.wrongLetters?.[myTarget?.username] || [];
  renderWrongLetters(wrongLetters);

  // My own word, with opponent-found letters highlighted
  const me = players[myIdx];
  renderOwnWord(me?.revealedWord || []);

  // Controls
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

  const word   = state.mySecretWord || "";
  const length = word.length || (revealedWord ? revealedWord.length : 0);

  for (let i = 0; i < length; i++) {
    const box   = document.createElement("div");
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

  // Winner banner
  const isWinner = room.winner === state.username;
  $("winner-name").textContent = isWinner
    ? "🎉 You Won!"
    : `${room.winner} Wins!`;

  // Reveal every player's secret word
  const list = $("secret-words-list");
  list.innerHTML = "";

  room.players.forEach((p, idx) => {
    const row = document.createElement("div");
    const isThisWinner = p.username === room.winner;
    row.className = "secret-word-row" + (isThisWinner ? " is-winner" : "");
    row.style.animationDelay = `${idx * 0.08}s`;

    // The server now sends p.word for every player when phase === "ended".
    // Fallback to state.mySecretWord for our own word (covers edge cases).
    const word =
      p.word ||
      (p.username === state.username ? state.mySecretWord : null) ||
      "?".repeat(room.wordLength || 5);
    const initials = p.username.slice(0, 2).toUpperCase();

    row.innerHTML = `
      <div class="sw-avatar">${isThisWinner ? "🏆" : initials}</div>
      <div class="sw-info">
        <div class="sw-username">
          ${p.username}
          ${isThisWinner ? `<span class="crown">👑</span>` : ""}
          ${p.username === state.username ? `<span class="badge badge-you">You</span>` : ""}
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