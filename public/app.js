(() => {
  const socket = io();
  const landing = document.querySelector("#landing");
  const hostView = document.querySelector("#host-view");
  const playerView = document.querySelector("#player-view");
  const landingError = document.querySelector("#landing-error");
  let role = null;
  let roomCode = null;
  let playerId = null;
  let reconnectToken = null;
  let roomState = null;
  let animationFrame = null;
  let markerPosition = 0;
  let markerDirection = 1;
  let practiceFrame = null;
  let practiceLastFrame = 0;
  let practiceState = null;
  let practiceBeerInterval = null;
  let practiceBeerTimeout = null;
  let lastFrame = 0;
  let flashMessage = "";
  let lastEffectKey = "";
  let observedDrinkKey = null;
  let beerRollState = null;
  let beerRollInterval = null;
  let beerRollTimeout = null;
  let heldSwingAnimationKey = null;
  let audioContext = null;
  let lastSoundSwingKey = "";
  let lastSoundDrinkKey = "";
  let turnTimerKey = null;
  let turnTimerDeadline = 0;
  let turnTimerInterval = null;

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);

  function showError(message) {
    landingError.textContent = message || "";
  }

  function reconnectStorageKey(code) {
    return `hammerschlagen-rejoin:${code.trim().toUpperCase()}`;
  }

  function savedReconnect(code) {
    let raw;
    try {
      raw = localStorage.getItem(reconnectStorageKey(code));
    } catch {
      showError("Browser storage is unavailable, so saved rejoin is disabled.");
      return null;
    }
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw);
      return typeof saved?.token === "string" && typeof saved?.name === "string" ? saved : null;
    } catch {
      localStorage.removeItem(reconnectStorageKey(code));
      return null;
    }
  }

  function updateRejoinButton() {
    const button = document.querySelector("#rejoin-game");
    const code = document.querySelector("#room-code").value;
    const saved = savedReconnect(code);
    button.classList.toggle("hidden", !saved);
    if (saved) {
      document.querySelector("#player-name").value = saved.name;
      button.textContent = `Rejoin as ${saved.name}`;
    }
  }

  function saveReconnect(code, name, token) {
    try {
      localStorage.setItem(reconnectStorageKey(code), JSON.stringify({ name, token }));
      localStorage.setItem("hammerschlagen-last-room", code);
      return true;
    } catch {
      return false;
    }
  }

  function observeBeerRoll(match) {
    const drink = match?.lastDrink;
    if (!drink) return null;
    const key = `${match.matchId}:${drink.playerId}:${drink.beersDrank}:${drink.roll}`;
    if (key !== observedDrinkKey) {
      observedDrinkKey = key;
      if (key !== lastSoundDrinkKey) {
        lastSoundDrinkKey = key;
        playSound("dice");
      }
      beerRollState = { key, rolling: true, value: Math.floor(Math.random() * 20) + 1 };
      clearInterval(beerRollInterval);
      clearTimeout(beerRollTimeout);
      beerRollInterval = setInterval(() => {
        if (beerRollState?.key !== key || !beerRollState.rolling) return;
        beerRollState.value = Math.floor(Math.random() * 20) + 1;
        const die = document.querySelector(".beer-die");
        const face = die?.querySelector("b");
        if (face) face.textContent = beerRollState.value;
      }, 80);
      beerRollTimeout = setTimeout(() => {
        clearInterval(beerRollInterval);
        beerRollState = { key, rolling: false, value: drink.roll };
        render();
      }, 1600);
    }
    return beerRollState?.key === key ? beerRollState : null;
  }

  function calculateSwingStats(player, isBent, hasBonus, isSuddenDeath = false) {
    const strength = isBent ? 0 : hasBonus ? 5 : player.strength;
    const baseWidth = Math.max(5, 16 + strength * 2.8 - player.drunk * 1.5);
    const width = Math.min(100, baseWidth * (isBent ? 0.5 : 1));
    const dexterityFactor = 0.7 + player.dexterity * 0.15;
    const speedAtZeroDexterity = 105 / (0.7 + 3 * 0.15) * 2.5;
    return {
      width,
      criticalWidth: isSuddenDeath ? 0 : isBent ? 2 : Math.min(7, 2 + player.strength * 0.25),
      bendWidth: (100 - width) * (0.25 + 0.5 * player.dexterity / 5) / 2,
      wisdomSlowdown: player.wisdom * 0.12,
      speed: Math.min(450, speedAtZeroDexterity * 0.75 / dexterityFactor)
    };
  }

  function playSound(kind) {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) return;
    audioContext ||= new AudioContextType();
    if (audioContext.state === "suspended") audioContext.resume();
    const now = audioContext.currentTime;
    const tone = (frequency, duration, type = "sine", volume = 0.12, delay = 0) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now + delay);
      gain.gain.setValueAtTime(volume, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + duration);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now + delay);
      oscillator.stop(now + delay + duration);
    };
    const noise = (duration, frequency, volume, delay = 0, filterType = "bandpass") => {
      const frameCount = Math.ceil(audioContext.sampleRate * duration);
      const buffer = audioContext.createBuffer(1, frameCount, audioContext.sampleRate);
      const data = buffer.getChannelData(0);
      for (let index = 0; index < frameCount; index++) data[index] = Math.random() * 2 - 1;
      const source = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const gain = audioContext.createGain();
      source.buffer = buffer;
      filter.type = filterType;
      filter.frequency.value = frequency;
      gain.gain.setValueAtTime(volume, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + duration);
      source.connect(filter).connect(gain).connect(audioContext.destination);
      source.start(now + delay);
    };

    if (kind === "hit") {
      tone(1450, 0.18, "triangle", 0.16);
      tone(2150, 0.12, "sine", 0.08, 0.025);
    } else if (kind === "bent") {
      tone(470, 0.24, "triangle", 0.2);
      noise(0.19, 850, 0.13);
      tone(190, 0.16, "sine", 0.1, 0.04);
    } else if (kind === "miss") {
      tone(115, 0.2, "sine", 0.22);
      noise(0.13, 260, 0.17, 0, "lowpass");
    } else if (kind === "dice") {
      for (let index = 0; index < 7; index++) {
        noise(0.035, 1800 + index * 120, 0.09, index * 0.075);
        tone(420 + (index % 3) * 115, 0.045, "square", 0.035, index * 0.075);
      }
    }
  }

  function renderD20(value) {
    const phi = (1 + Math.sqrt(5)) / 2;
    const vertices = [
      [0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi],
      [1, phi, 0], [-1, phi, 0], [1, -phi, 0], [-1, -phi, 0],
      [phi, 0, 1], [-phi, 0, 1], [phi, 0, -1], [-phi, 0, -1]
    ];
    const rotate = ([x, y, z]) => [x * 0.84 - z * 0.54, y * 0.91 + x * 0.22 + z * 0.34, z * 0.78 + x * 0.52];
    const projected = vertices.map(rotate);
    const faces = [];
    for (let a = 0; a < vertices.length; a++) {
      for (let b = a + 1; b < vertices.length; b++) {
        for (let c = b + 1; c < vertices.length; c++) {
          const distance = (u, v) => vertices[u].reduce((sum, coordinate, axis) => sum + (coordinate - vertices[v][axis]) ** 2, 0);
          if ([distance(a, b), distance(a, c), distance(b, c)].every((length) => Math.abs(length - 4) < 0.001)) {
            const points = [projected[a], projected[b], projected[c]];
            const centerZ = points.reduce((sum, point) => sum + point[2], 0) / 3;
            faces.push({ points, centerZ });
          }
        }
      }
    }
    faces.sort((left, right) => left.centerZ - right.centerZ);
    const all = projected.flatMap(([x, y]) => [x, y]);
    const minX = Math.min(...all.filter((_, index) => index % 2 === 0));
    const maxX = Math.max(...all.filter((_, index) => index % 2 === 0));
    const minY = Math.min(...all.filter((_, index) => index % 2 === 1));
    const maxY = Math.max(...all.filter((_, index) => index % 2 === 1));
    const scale = 25 / Math.max(maxX - minX, maxY - minY);
    const project = ([x, y]) => `${(32 + (x - (minX + maxX) / 2) * scale).toFixed(1)},${(32 - (y - (minY + maxY) / 2) * scale).toFixed(1)}`;
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${faces.map(({ points, centerZ }, index) =>
      `<polygon points="${points.map(project).join(" ")}" fill="hsl(36 52% ${centerZ > 0.4 ? 64 : 51}%)" stroke="#5a3b21" stroke-width="1.2" />`
    ).join("")}</svg><b>${value}</b>`;
  }

  function showToast(message) {
    flashMessage = message || "";
    const element = document.querySelector("#game-message");
    if (element) element.textContent = flashMessage;
  }

  function playerName(id) {
    return roomState.players.find((player) => player.id === id)?.name || "Unknown player";
  }

  function findPlayer(id) {
    return roomState.players.find((player) => player.id === id);
  }

  function displayedDrunk(player, drink, beerRoll) {
    if (beerRoll?.rolling && drink?.playerId === player?.id) {
      return drink.previousDrunk ?? player.drunk;
    }
    return player?.drunk || 0;
  }

  function emitWithCallback(event, payload) {
    return new Promise((resolve) => {
      if (payload === undefined) socket.emit(event, resolve);
      else socket.emit(event, payload, resolve);
    });
  }

  async function createRoom() {
    const response = await emitWithCallback("host:create");
    if (!response?.ok) {
      showError("Could not create a room. Please try again.");
      return;
    }
    role = "host";
    roomCode = response.state.code;
    roomState = response.state;
    landing.classList.add("hidden");
    render();
  }

  async function joinRoom(event) {
    event.preventDefault();
    showError("");
    const form = new FormData(event.currentTarget);
    const response = await emitWithCallback("player:join", {
      code: document.querySelector("#room-code").value,
      name: document.querySelector("#player-name").value,
      stats: {
        strength: Number(form.get("strength")),
        dexterity: Number(form.get("dexterity")),
        constitution: Number(form.get("constitution")),
        wisdom: Number(form.get("wisdom"))
      }
    });
    if (!response?.ok) {
      showError(response?.error || "Could not join this room.");
      return;
    }
    role = "player";
    roomCode = response.state.code;
    playerId = response.playerId;
    reconnectToken = response.reconnectToken;
    const reconnectSaved = saveReconnect(roomCode, document.querySelector("#player-name").value.trim(), reconnectToken);
    roomState = response.state;
    landing.classList.add("hidden");
    render();
    if (!reconnectSaved) showToast("You joined, but this browser could not save your reconnect token.");
  }

  async function rejoinRoom(code = roomCode, token = reconnectToken) {
    if (!code || !token) return false;
    const response = await emitWithCallback("player:rejoin", { code, reconnectToken: token });
    if (!response?.ok) {
      const message = response?.error || "Could not rejoin this room.";
      if (role === "player") showToast(message);
      else showError(message);
      return false;
    }
    role = "player";
    roomCode = response.state.code;
    playerId = response.playerId;
    reconnectToken = token;
    roomState = response.state;
    landing.classList.add("hidden");
    render();
    return true;
  }

  function matchupStatsMarkup(player, match) {
    return [
      ["STR", "strength"],
      ["DEX", "dexterity"],
      ["CON", "constitution"],
      ["WIS", "wisdom"]
    ].map(([label, stat]) => {
      const lowered = (match.statPenalties?.[player.id]?.[stat] || 0) > 0;
      return `${label} <span class="${lowered ? "stat-lowered" : ""}">${player[stat]}</span>`;
    }).join(" · ");
  }

  function statSelect(player, stat, title) {
    return `<label>${title}
      <select data-stat="${stat}" data-player="${player.id}" aria-label="${escapeHtml(player.name)} ${title}">
        ${[0, 1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${player[stat] === value ? "selected" : ""}>${value}</option>`).join("")}
      </select>
    </label>`;
  }

  function characterImageUrl(filename) {
    return `/assets/${encodeURIComponent(filename)}`;
  }

  function characterImagePicker(player) {
    const images = roomState.characterImages || ["Generic NPC.png"];
    return `<details class="character-picker">
      <summary aria-label="Choose character image"><img src="${characterImageUrl(player.characterImage || "Generic NPC.png")}" alt=""><span>Choose image</span></summary>
      <div class="character-options" role="listbox" aria-label="Character images">
        ${images.map((filename) => `<button type="button" role="option" aria-label="Select character image" data-character-image="${escapeHtml(filename)}" data-player="${escapeHtml(player.id)}"><img src="${characterImageUrl(filename)}" alt=""></button>`).join("")}
      </div>
    </details>`;
  }

  function winnerChoiceMarkup(playerIds) {
    if (playerIds.length !== 2) return "";
    return `<label class="winner-choice">Preselect winner (optional)
      <select id="preselected-winner">
        <option value="">Play this match</option>
        ${playerIds.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(playerName(id))}</option>`).join("")}
      </select>
    </label>`;
  }

  function hostRoster() {
    return roomState.players.map((player, index) => `
      <div class="participant-row ${roomState.phase === "lobby" ? "draggable-participant" : ""}" ${roomState.phase === "lobby" ? `draggable="true" data-player-id="${escapeHtml(player.id)}"` : ""}>
        <div class="participant-heading">
          ${roomState.phase === "lobby" ? '<span class="drag-handle" aria-hidden="true">⠿</span>' : ""}
          <span class="seed">#${index + 1}</span>
          <span class="player-name">${escapeHtml(player.name)} ${player.isNpc ? '<span class="status-pill">NPC</span>' : player.connected === false ? '<span class="status-pill">Disconnected</span>' : ""}</span>
          ${roomState.phase === "lobby" ? characterImagePicker(player) : ""}
          ${roomState.phase === "lobby" ? `
            <span class="order-buttons">
              <button class="icon-button" data-move="${index - 1}" aria-label="Move ${escapeHtml(player.name)} up" ${index === 0 ? "disabled" : ""}>↑</button>
              <button class="icon-button" data-move="${index + 1}" aria-label="Move ${escapeHtml(player.name)} down" ${index === roomState.players.length - 1 ? "disabled" : ""}>↓</button>
            </span>` : `<span class="muted">${player.wins} win${player.wins === 1 ? "" : "s"}</span>`}
        </div>
        <div class="stats-grid">
          ${statSelect(player, "strength", "Strength")}
          ${statSelect(player, "dexterity", "Dexterity")}
          ${statSelect(player, "constitution", "Constitution")}
          ${statSelect(player, "wisdom", "Wisdom")}
        </div>
        <p class="participant-meta">Hits ${player.wins} · Beers ${player.beersDrank}${player.drunk ? ` · Intoxicated x${player.drunk}` : ""}</p>
      </div>`).join("");
  }

  function hostMarkup() {
    const canStart = roomState.players.length >= 2 && roomState.phase === "lobby";
    const settings = roomState.defaultMatchSettings;
    return `
      <div class="view">
        <div class="topline">
          <div><p class="eyebrow">Host controls</p><h2>Your game room</h2></div>
          <div class="room-code">${roomState.code}</div>
        </div>
        <section class="card">
          <p class="help">Share this code with up to 32 participants: <strong>${roomState.code}</strong>. Players open this page on their own devices and enter the code.</p>
          <div class="topline"><h3>Participants &amp; bracket seeds</h3><span class="status-pill">${roomState.players.length}/32 joined</span></div>
          ${roomState.phase === "lobby" ? '<p class="help">Drag participants to set their seeds; each adjacent pair forms a first-round matchup. Use the arrows if dragging is unavailable.</p>' : ""}
          ${roomState.players.length ? `<div class="roster">${hostRoster()}</div>` : `<p class="muted">Waiting for players…</p>`}
          ${roomState.phase === "lobby" ? `
            <form id="add-npc-form" class="npc-form">
              <label>NPCs (Name,Strength,Dexterity,Constitution,Wisdom)
                <textarea name="entries" rows="4" placeholder="Rivet,5,5,3,4&#10;Sparky,2,4,1,3" required></textarea>
              </label>
              <button class="button button-secondary" type="submit" ${roomState.players.length >= 32 ? "disabled" : ""}>Add NPCs</button>
            </form>
            <div class="lobby-actions">
              <button id="randomize-bracket" class="button button-secondary" ${roomState.players.length < 2 ? "disabled" : ""}>Randomize bracket order</button>
              <button id="start-tournament" class="button button-primary" ${canStart ? "" : "disabled"}>Start tournament</button>
            </div>
            ${matchSettingsMarkup(settings, "Default match format")}
            ${winnerChoiceMarkup(roomState.players.slice(0, 2).map((player) => player.id))}
            <p class="help">This is a double-elimination tournament: one loss moves a participant to the losers bracket, and a second loss eliminates them. You can change stats during the tournament.</p>
          ` : `<p class="help">Adjust any participant's stats above during the tournament. Changes apply to their next swing.</p>`}
          <label class="mode-select">NPC turn mode
            <select id="npc-match-mode">
              <option value="watch" ${roomState.npcMatchMode === "watch" ? "selected" : ""}>Pause between NPC turns for host</option>
              <option value="skip" ${roomState.npcMatchMode === "skip" ? "selected" : ""}>Automatic NPC turns</option>
            </select>
          </label>
          <p id="host-error" class="error" role="status"></p>
        </section>
        ${tournamentMarkup(true)}
      </div>`;
  }

  function matchSettingsMarkup(settings, title) {
    return `<fieldset class="match-settings"><legend>${title}</legend>
      <label>Hits to win
        <select data-match-setting="hitsToWin">
          ${Array.from({ length: 10 }, (_, index) => index + 1).map((value) =>
          `<option value="${value}" ${settings.hitsToWin === value ? "selected" : ""}>${value}</option>`
        ).join("")}</select>
      </label>
      <label>Best of
        <select data-match-setting="bestOf">
          <option value="1" ${settings.bestOf === 1 ? "selected" : ""}>1 game</option>
          <option value="3" ${settings.bestOf === 3 ? "selected" : ""}>3 games</option>
        </select>
      </label>
      <label class="checkbox-label"><input type="checkbox" data-match-setting="skipNpcOnly" ${settings.skipNpcOnly ? "checked" : ""}> Skip NPC-only matches</label>
    </fieldset>`;
  }

  function beerMugsMarkup(player, count = player?.beersDrank || 0) {
    const beersDrank = count;
    return `<div class="stump-beers" aria-label="${beersDrank} empty beer mug${beersDrank === 1 ? "" : "s"}">
      <div class="beer-mugs">${Array.from({ length: beersDrank }, () =>
        '<svg class="empty-mug" viewBox="0 0 20 24" aria-hidden="true"><path d="M3 3h11v17H3zM14 7h2.5a2.5 2.5 0 0 1 0 5H14" /></svg>'
      ).join("")}</div>
    </div>`;
  }

  function winnerConfettiMarkup() {
    return `<div class="stump-winner-confetti" aria-hidden="true">${Array.from({ length: 16 }, (_, item) =>
      `<span style="--x:${(item * 37 % 121) - 60}px;--y:${-20 - (item * 17 % 55)}px;--hue:${item * 47 % 360}deg</span>`
    ).join("")}</div>`;
  }

  function stumpMarkup(match) {
    const fighters = match?.playerIds.map((id) => findPlayer(id)) || [null, null];
    const nails = fighters.map((fighter, index) => {
      const score = fighter ? match.scores[fighter.id] || 0 : 0;
      const progress = match ? Math.min(1, score / match.hitsToWin) : 0;
      const x = index === 0 ? 135 : 265;
      const fullyDriven = Boolean(match && score >= match.hitsToWin);
      const nailTipY = 119;
      const top = 65 + progress * (nailTipY - 9 - 65);
      const exposedLength = nailTipY - top;
      const bent = Boolean(fighter && match.bentIds.includes(fighter.id));
      const rotation = bent ? (index === 0 ? -18 : 18) : 0;
      return `<g class="stump-nail ${bent ? "bent" : ""} ${fullyDriven ? "fully-driven" : ""}" transform="translate(${x} ${nailTipY}) rotate(${rotation})">
        <path class="nail-body" d="M-3 0 V-${exposedLength - 5} H-6 V-${exposedLength} H6 V-${exposedLength - 5} H3 V0 Z" />
        <path class="nail-highlight" d="M-1 -8 L-1 -${exposedLength - 2}" />
        <path class="nail-head-detail" d="M-4 -${exposedLength - 2} H4" />
      </g>
      <ellipse class="nail-entry-shadow" cx="${x}" cy="${nailTipY}" rx="4.5" ry="2.5" />`;
    }).join("");
    return `<div class="stump-visual">
      <svg class="stump-svg" viewBox="0 0 400 230" role="img" aria-label="Tree stump with each player's nail progress">
        <defs>
          <linearGradient id="stump-bark" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stop-color="#b9824f" /><stop offset=".22" stop-color="#80502d" /><stop offset=".58" stop-color="#60391f" /><stop offset="1" stop-color="#392216" />
          </linearGradient>
          <linearGradient id="stump-endgrain" x1="0" x2=".15" y1="0" y2="1">
            <stop offset="0" stop-color="#e0b47c" /><stop offset=".45" stop-color="#bd8957" /><stop offset="1" stop-color="#94613b" />
          </linearGradient>
          <linearGradient id="stump-cut-edge" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#d0a06a" /><stop offset=".35" stop-color="#80502f" /><stop offset="1" stop-color="#492b1b" />
          </linearGradient>
          <clipPath id="stump-body-clip"><path d="M50 122h300v77c-73 20-227 20-300 0z" /></clipPath>
        </defs>
        <path class="stump-body" d="M50 122h300v77c-73 20-227 20-300 0z" />
        <g class="stump-bark-detail" clip-path="url(#stump-body-clip)">
          <path d="M62 128q18 14 2 58M83 125q15 18 2 65M112 125q-8 21 3 65M151 125q13 20 2 69M197 126q-11 19 1 70M238 125q14 18 1 68M282 125q-11 20 1 66M322 125q16 17 2 63M340 128q-10 15 0 52" />
          <path d="M56 157q42 8 68 0t59 3 67-2 91 2M59 180q48-8 78 1t62-2 68 2 80-3" />
          <ellipse cx="93" cy="163" rx="9" ry="15" /><ellipse cx="93" cy="163" rx="4" ry="9" />
          <ellipse cx="305" cy="149" rx="7" ry="12" /><ellipse cx="305" cy="149" rx="3" ry="7" />
        </g>
        <path class="stump-rim" d="M50 122h300v77c-73 20-227 20-300 0z" />
        <ellipse class="stump-cut-edge" cx="200" cy="122" rx="150" ry="42" />
        <ellipse class="stump-top" cx="200" cy="119" rx="143" ry="37" />
        <ellipse class="stump-ring outer" cx="200" cy="119" rx="119" ry="29" />
        <ellipse class="stump-ring" cx="200" cy="119" rx="98" ry="23" />
        <ellipse class="stump-ring inner" cx="200" cy="119" rx="75" ry="17" />
        <ellipse class="stump-ring" cx="200" cy="119" rx="49" ry="11" />
        <ellipse class="stump-pith" cx="200" cy="119" rx="13" ry="4" />
        <path class="stump-crack" d="M200 119l-9-24m9 24 21-16m-21 16 13 23m-13-23-30 4m30-4 34 8m-34-8 3-28" />
        ${nails}
      </svg>
      <p class="stump-caption">${match ? `Game ${match.gameNumber} · Best of ${match.bestOf}` : "The stump is ready for the next match"}</p>
    </div>`;
  }

  function tournamentMarkup(isHost) {
    if (roomState.phase === "lobby") return "";
    const match = roomState.currentMatch;
    const activeId = match?.playerIds[match.turnIndex];
    const activePlayer = findPlayer(activeId);
    const isMyTurn = Boolean(playerId && activeId === playerId);
    const isManualNpcTurn = Boolean(isHost && roomState.npcManualTurnId === activeId && activePlayer?.isNpc);
    const canControlTurn = isMyTurn || isManualNpcTurn;
    const controlledPlayerId = isManualNpcTurn ? activeId : playerId;
    const isPendingDrink = Boolean(playerId && match && match.pendingDrinkPlayerId === playerId);
    const isSuddenDeathDrinkRequired = Boolean(
      match?.suddenDeathActive && controlledPlayerId === activeId &&
      !match.suddenDeathBeerDrank?.[activeId]
    );
    const pendingAdvance = match?.pendingAdvance;
    const canPlayerConfirm = Boolean(playerId && pendingAdvance?.playerId === playerId);
    const canEndTurn = Boolean((isHost && pendingAdvance) || canPlayerConfirm);
    const isWaitingForConfirm = Boolean(pendingAdvance);
    const myBent = Boolean(match?.bentIds.includes(controlledPlayerId));
    const lastDrink = match?.lastDrink;
    const currentBeerRoll = observeBeerRoll(match);
    const swingPlayer = activePlayer || { strength: 3, dexterity: 3, drunk: 0 };
    const isBent = Boolean(match?.bentIds.includes(activeId));
    const hasBonus = Boolean(match?.bonusIds.includes(activeId));
    const heldSwing = (isWaitingForConfirm || Boolean(match?.pendingDrinkPlayerId)) &&
      match?.lastSwing?.playerId === activeId ? match.lastSwing : null;
    const shownBent = heldSwing ? heldSwing.bent : isBent;
    const shownBonus = heldSwing ? heldSwing.bonus : hasBonus;
    const shownDrunk = displayedDrunk(swingPlayer, lastDrink, currentBeerRoll);
    const statsPlayer = { ...swingPlayer, drunk: shownDrunk };
    const liveSwingStats = calculateSwingStats(statsPlayer, isBent, hasBonus, Boolean(match?.suddenDeathActive));
    const delayedDrinkForSwing = currentBeerRoll?.rolling && lastDrink?.playerId === activeId;
    const shownSwingStats = delayedDrinkForSwing && heldSwing
      ? calculateSwingStats(statsPlayer, heldSwing.bent, heldSwing.bonus, Boolean(match?.suddenDeathActive))
      : heldSwing?.stats || liveSwingStats;
    const { width, criticalWidth, bendWidth, speed } = shownSwingStats;
    const targetStart = 50 - width / 2;
    const dangerWidth = Math.min(bendWidth, targetStart);
    const rightDangerStart = targetStart + width;
    const rightDangerWidth = Math.min(bendWidth, 100 - rightDangerStart);
    const nextReady = isHost && roomState.phase === "tournament" && !match;
    const beerRollMarkup = currentBeerRoll
      ? `<div class="beer-roll" role="status" aria-live="polite"><span class="beer-die ${currentBeerRoll.rolling ? "rolling" : ""}" aria-label="Twenty-sided die showing ${currentBeerRoll.value}">
          ${renderD20(currentBeerRoll.value)}</span><span>${currentBeerRoll.rolling ? "Rolling d20…" : `Sobriety Check DC ${lastDrink.threshold}: rolled a ${lastDrink.roll + lastDrink.constitution} (${lastDrink.roll}+${lastDrink.constitution})`}</span></div>`
      : "";
    const finalSwing = !match ? roomState.history.at(-1)?.lastSwing : null;
    const finalStats = finalSwing?.stats;
    const finalTargetStart = finalStats ? 50 - finalStats.width / 2 : 0;
    const finalLeftBendWidth = finalStats ? Math.min(finalStats.bendWidth, finalTargetStart) : 0;
    const finalRightBendStart = finalTargetStart + (finalStats?.width || 0);
    const finalRightBendWidth = finalStats ? Math.min(finalStats.bendWidth, 100 - finalRightBendStart) : 0;
    const finalSwingMarkup = finalSwing
      ? `<div class="last-swing"><p class="help">Last swing by ${escapeHtml(playerName(finalSwing.playerId))}: ${escapeHtml(finalSwing.action)}</p><div class="meter ${finalSwing.drunk ? "wobble" : ""}" aria-label="Last swing meter" data-speed="${finalStats?.speed || 0}" style="--wiggle:${Math.min(12, 2 + (finalSwing.drunk || 0) * 2)}px;--wiggle-time:${Math.max(120, 280 - (finalSwing.drunk || 0) * 30)}ms">
          ${finalStats ? `<div class="bend-risk" style="left:${Math.max(0, finalTargetStart - finalLeftBendWidth)}%;width:${finalLeftBendWidth}%"></div>
            <div class="target-zone" style="left:${finalTargetStart}%;width:${finalStats.width}%"></div>
            <div class="bend-risk" style="left:${finalRightBendStart}%;width:${finalRightBendWidth}%"></div>
            ${finalStats.criticalWidth ? `<div class="bullseye-zone" style="left:${50 - finalStats.criticalWidth / 2}%;width:${finalStats.criticalWidth}%"></div>` : ""}` : ""}
          <div class="needle held" style="left:${finalSwing.position}%"></div></div></div>`
      : "";
    const completedMatch = roomState.lastMatchStump;
    const completedMatchCardsMarkup = completedMatch
      ? `<div class="matchup completed-matchup">${completedMatch.playerIds.map((id, index) => {
          const fighter = findPlayer(id);
          const isWinner = id === completedMatch.winnerId;
          return `<div class="duelist-column">
            <div class="duelist ${isWinner ? "match-winner" : ""}">
              ${isWinner ? winnerConfettiMarkup() : ""}
              <img class="duelist-portrait" src="${characterImageUrl(fighter?.characterImage || "Generic NPC.png")}" alt="${escapeHtml(fighter?.name || "Participant")}">
              <div class="player-name">${escapeHtml(fighter?.name || `Player ${index ? "B" : "A"}`)}</div>
              <div class="score">${completedMatch.scores[id] || 0}<span class="muted">/${completedMatch.hitsToWin}</span></div>
              ${completedMatch.bestOf === 3 ? `<div class="series-score">Games ${completedMatch.gameWins[id] || 0}</div>` : ""}
              <div class="help">STR ${fighter?.strength ?? 0} · DEX ${fighter?.dexterity ?? 0} · CON ${fighter?.constitution ?? 0} · WIS ${fighter?.wisdom ?? 0}${fighter?.drunk ? `<br>Intoxicated x${fighter.drunk}` : ""}</div>
              ${beerMugsMarkup(fighter, completedMatch.beers?.[id] ?? 0)}
            </div>
          </div>${index === 0 ? '<span class="versus">VS</span>' : ""}`;
        }).join("")}</div>`
      : "";

    const bracketMatches = [
      ...roomState.history.map((entry) => ({ ...entry, status: "complete" })),
      ...(match ? [{ ...match, status: "active" }] : []),
      ...roomState.pendingMatches.map((entry) => ({ ...entry, status: "upcoming" }))
    ];
    const bracket = [
      ["winners", "Winners bracket"],
      ["losers", "Losers bracket"],
      ["finals", "Championship finals"]
    ].map(([lane, label]) => {
      const laneMatches = bracketMatches.filter((entry) => (entry.lane || "winners") === lane);
      const rounds = new Map();
      laneMatches.forEach((entry) => {
        if (!rounds.has(entry.round)) rounds.set(entry.round, []);
        rounds.get(entry.round).push(entry);
      });
      let remainingPlayers = roomState.seedIds.length;
      let winnersRoundCount = 0;
      while (remainingPlayers > 1) {
        winnersRoundCount += 1;
        remainingPlayers = Math.ceil(remainingPlayers / 2);
      }
      const blankStatus = roomState.phase === "complete" ? "empty" : "upcoming";
      if (lane === "winners") {
        let entrants = roomState.seedIds.length;
        for (let round = 1; round <= winnersRoundCount; round += 1) {
          const roundName = `Winners Round ${round}`;
          const matchCount = Math.floor(entrants / 2);
          if (!rounds.has(roundName)) rounds.set(roundName, []);
          while (rounds.get(roundName).length < matchCount) {
            rounds.get(roundName).push({ round: roundName, playerIds: [null, null], status: blankStatus });
          }
          entrants = matchCount + entrants % 2;
        }
      } else if (lane === "losers") {
        const loserRoundCount = Math.max(1, (winnersRoundCount - 1) * 2);
        for (let round = 1; round <= loserRoundCount; round += 1) {
          const roundName = `Losers Round ${round}`;
          const matchCount = Math.max(1, Math.ceil((roomState.seedIds.length - 1) /
            (2 ** (Math.ceil(round / 2) + 1))));
          if (!rounds.has(roundName)) rounds.set(roundName, []);
          while (rounds.get(roundName).length < matchCount) {
            rounds.get(roundName).push({ round: roundName, playerIds: [null, null], status: blankStatus });
          }
        }
      } else {
        for (const roundName of ["Grand Final", "Grand Final Reset"]) {
          if (!rounds.has(roundName)) {
            rounds.set(roundName, [{ round: roundName, playerIds: [null, null], status: blankStatus }]);
          }
        }
      }
      const roundMarkup = [...rounds.entries()].sort(([first], [second]) => {
        const roundOrder = (name) => name === "Grand Final" ? 0
          : name === "Grand Final Reset" ? 1
            : Number(name.match(/\d+/)?.[0] || 0);
        return roundOrder(first) - roundOrder(second);
      }).map(([round, entries]) => `
        <section class="bracket-round">
          <h4>${escapeHtml(round)}</h4>
          <div class="bracket-matches">
            ${entries.map((entry) => `<div class="bracket-match ${entry.status} ${entry.playerIds.every((id) => !id) ? "placeholder" : ""}">
              <span class="bracket-status">${entry.status === "complete" ? "Complete" : entry.status === "active" ? "In progress" : entry.playerIds.every((id) => !id) ? roomState.phase === "complete" ? "Not played" : "Upcoming match" : "Up next"}</span>
              ${entry.playerIds.map((id) => {
                const score = entry.gameWins?.[id] ?? (entry.status === "complete" ? entry.scores?.[id] : "");
                const suddenDeathWin = id && entry.suddenDeathWinners?.includes(id);
                return `<div class="bracket-player ${id && id === entry.winnerId ? "winner" : ""}">${id ? escapeHtml(playerName(id)) : "&nbsp;"}<span>${id ? `${score ?? ""}${suddenDeathWin ? ' <span class="sudden-death-star" title="Game won in sudden death" aria-label="Won a game in sudden death">★</span>' : ""}` : ""}</span></div>`;
              }).join("")}
            </div>`).join("")}
          </div>
        </section>`).join("");
      return `<section class="bracket-lane"><h4>${label}</h4>${roundMarkup ? `<div class="bracket-rounds">${roundMarkup}</div>` : `<p class="muted">${lane === "losers" ? "Losers advance here after their first loss." : lane === "finals" ? "Finalists will meet here." : "Winners advance through this bracket."}</p>`}</section>`;
    }).join("");

    return `
      <div class="game-layout match-progress-layout">
        <section class="card">
          <p class="eyebrow">Tournament · Round ${roomState.roundNumber}</p>
          ${roomState.championId
            ? `<h2>Champion crowned</h2><p class="champion">${escapeHtml(playerName(roomState.championId))}</p>${completedMatchCardsMarkup}${finalSwingMarkup}<div class="match-stump-inline">${stumpMarkup(completedMatch)}</div><div class="final-spark-stage"><div id="hit-spark" class="hit-spark" aria-hidden="true"></div></div>`
            : match
              ? `<h2>${escapeHtml(match.round)}</h2>
                 ${isHost ? `<div class="current-match-settings">
                   <label class="current-format">Series format
                     <select id="current-best-of">
                       <option value="1" ${match.bestOf === 1 ? "selected" : ""}>Best of 1</option>
                       <option value="3" ${match.bestOf === 3 ? "selected" : ""}>Best of 3</option>
                     </select>
                   </label>
                   <label class="current-format">Hits to win
                     <select id="current-hits-to-win">
                       ${Array.from({ length: 10 }, (_, index) => index + 1).map((hits) =>
                         `<option value="${hits}" ${hits < Math.max(...match.playerIds.map((playerId) => match.scores[playerId])) ? "disabled" : ""} ${match.hitsToWin === hits ? "selected" : ""}>${hits}</option>`
                       ).join("")}
                     </select>
                   </label>
                 </div>
                 <div class="actions automatic-winner">
                   <label class="winner-choice">Automatic winner
                     <select id="automatic-winner">
                       <option value="">Choose participant</option>
                       ${match.playerIds.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(playerName(id))}</option>`).join("")}
                     </select>
                   </label>
                   <button id="award-match" class="button button-secondary">Award match · ${match.hitsToWin}/${match.hitsToWin} hits</button>
                 </div>` : ""}
                 <div class="matchup">
                   ${match.playerIds.map((id, index) => {
                     const fighter = findPlayer(id);
                     const fighterNpcHitChance = Math.round(
                       20 + (fighter.strength + fighter.dexterity + fighter.wisdom) * 5
                     );
                     const fighterDrunk = displayedDrunk(fighter, lastDrink, currentBeerRoll);
                     return `<div class="duelist-column">
                       <div class="duelist ${index === match.turnIndex ? "active" : ""} ${fighterDrunk ? "drunk-card" : ""}">
                       <img class="duelist-portrait" src="${characterImageUrl(fighter.characterImage || "Generic NPC.png")}" alt="${escapeHtml(fighter.name)}">
                       <div class="player-name">${escapeHtml(fighter.name)}</div>
                       ${isHost && fighter.isNpc ? `<div class="npc-hit-chance">Hit chance ${fighterNpcHitChance}%</div>` : ""}
                       <div class="score">${match.scores[id]}<span class="muted">/${match.hitsToWin}</span></div>
                       ${match.bestOf === 3 ? `<div class="series-score">Games ${match.gameWins[id]} · Game ${match.gameNumber}/3</div>` : ""}
                       <div class="help">${matchupStatsMarkup(fighter, match)}${fighterDrunk ? `<br>Intoxicated x${fighterDrunk}` : ""}</div>
                       ${beerMugsMarkup(fighter)}
                       ${isHost ? `<label class="host-intoxication">Set intoxication
                         <input type="number" min="0" max="6" step="1" value="${fighterDrunk}" ${currentBeerRoll?.rolling ? "disabled" : ""} data-match-drunk="${escapeHtml(id)}" aria-label="Set ${escapeHtml(fighter.name)} intoxication">
                       </label>` : ""}
                       </div>
                     </div>${index === 0 ? '<span class="versus">VS</span>' : ""}`;
                   }).join("")}
                 </div>
                 <div class="turn-banner ${isMyTurn || isPendingDrink || canPlayerConfirm || isHost && isWaitingForConfirm ? "" : "waiting"}">
                   ${isWaitingForConfirm ? match.gamePointId === pendingAdvance.playerId ? `${escapeHtml(playerName(pendingAdvance.playerId))} reached the target — ${escapeHtml(playerName(match.playerIds.find((id) => id !== pendingAdvance.playerId)))} gets one final turn.` : pendingAdvance.outcome === "sobered-up" ? `${escapeHtml(playerName(pendingAdvance.playerId))} sobered up — end the turn.` : match.suddenDeathActive ? `${escapeHtml(playerName(pendingAdvance.playerId))} ${["hit", "bullseye", "sudden-death"].includes(pendingAdvance.outcome) ? "hit" : "did not hit"} in sudden death — end the turn.` : `${escapeHtml(playerName(pendingAdvance.playerId))}'s turn: ${escapeHtml(pendingAdvance.outcome)} — end the turn.` : isPendingDrink ? "Full miss! Drink a beer to finish your turn." : isSuddenDeathDrinkRequired ? "Sudden death: drink a beer before you swing." : activePlayer?.isNpc ? isManualNpcTurn ? `Host controls ${escapeHtml(activePlayer.name)}'s turn` : roomState.npcStepRequired ? `Waiting for host to start ${escapeHtml(activePlayer.name)}'s turn` : roomState.npcStepInProgress ? `${escapeHtml(activePlayer.name)} is lining up a swing…` : `${escapeHtml(activePlayer.name)} is swinging…` : isMyTurn ? "Your turn" : `${escapeHtml(activePlayer?.name || "Player")} is up`}
                 </div>
                 <div class="meter-scroll">
                   <div class="target-label"><span>Miss</span><span>Bend</span><span>Hit zone</span><span>Bend</span><span>Miss</span></div>
                   <div class="meter-frame ${shownDrunk ? "wobble" : ""}" style="--wiggle:${Math.min(12, 2 + shownDrunk * 2)}px;--wiggle-time:${Math.max(120, 280 - shownDrunk * 30)}ms">
                   <div id="hit-spark" class="hit-spark" aria-hidden="true"></div>
                   <div id="hammer" class="hammer-marker ${heldSwing ? "swing-marker" : ""}" aria-hidden="true"><svg viewBox="0 0 40 24"><path class="hammer-handle" d="M1 14h27" /><rect class="hammer-head" x="26" y="3" width="12" height="20" rx="1" /></svg></div>
                   <div class="meter" aria-label="Timing meter" data-speed="${speed}" data-hit-width="${width}" data-wisdom-slowdown="${shownSwingStats.wisdomSlowdown || 0}">
                     <div class="bend-risk" style="left:${Math.max(0, targetStart - dangerWidth)}%;width:${dangerWidth}%"></div>
                     <div class="target-zone" style="left:${targetStart}%;width:${width}%"></div>
                     <div class="bend-risk" style="left:${rightDangerStart}%;width:${rightDangerWidth}%"></div>
                     ${criticalWidth ? `<div class="bullseye-zone" title="Bullseye: worth two hits" style="left:${50 - criticalWidth / 2}%;width:${criticalWidth}%"></div>` : ""}
                     <div id="needle" class="needle ${isWaitingForConfirm || isPendingDrink ? "held" : ""}" style="${match?.lastSwing ? `left:${match.lastSwing.position}%` : ""}"></div>
                   </div>
                   </div>
                 </div>
                 ${canControlTurn || canPlayerConfirm ? `<div class="actions">
                   ${canPlayerConfirm
                     ? ""
                     : isPendingDrink
                     ? '<button id="drink-beer" class="button button-primary">Drink a Beer · roll d20</button>'
                     : isSuddenDeathDrinkRequired
                     ? '<button id="drink-beer" class="button button-primary">Drink a Beer before swinging · roll d20</button>'
                     : isWaitingForConfirm ? "" : `<button id="swing" class="button button-primary" ${currentBeerRoll?.rolling ? "disabled" : ""}>${isManualNpcTurn ? "Swing for NPC" : "Swing"} <span class="key">SPACE BAR</span></button>${myBent ? `<button id="${isManualNpcTurn ? "host-straighten-npc" : "straighten"}" class="button button-secondary" ${currentBeerRoll?.rolling ? "disabled" : ""}>Straighten nail · uses turn</button>` : ""}${shownDrunk && !match.suddenDeathActive ? `<button id="${isManualNpcTurn ? "host-sober-up-npc" : "sober-up"}" class="button button-secondary" ${currentBeerRoll?.rolling ? "disabled" : ""}>Sober Up (Intoxicated - CON/2) · uses turn</button>` : ""}`}
                 </div>` : ""}
                 ${isMyTurn && !isWaitingForConfirm && !isPendingDrink && !isSuddenDeathDrinkRequired
                   ? '<p id="turn-timer" class="turn-timer" role="timer" aria-live="off">Swing automatically in 20s</p>' : ""}
                 ${beerRollMarkup}
                 ${canEndTurn ? `<div class="actions turn-ending"><button id="${isHost ? "host-confirm-turn" : "confirm-turn"}" class="button button-primary" ${currentBeerRoll?.rolling ? "disabled" : ""}>End Turn <span class="key">SPACE BAR</span></button></div>` : ""}
                 <div class="match-stump-inline">${stumpMarkup(match)}</div>
                 ${shownBent ? '<p class="help">A bent nail halves the hit zone and stays bent until straightened.</p>' : ""}`
              : `<h2>Match complete</h2><p class="muted">The next round is ready when the host starts it.</p>${completedMatchCardsMarkup}${finalSwingMarkup}<div class="match-stump-inline">${stumpMarkup(completedMatch)}</div><div class="final-spark-stage"><div id="hit-spark" class="hit-spark" aria-hidden="true"></div></div>`}
          ${isHost && roomState.npcStepRequired ? '<div class="actions npc-turn-actions"><button id="next-npc-turn" class="button button-primary">Start next NPC turn</button><button id="play-as-npc" class="button button-secondary">Play as NPC</button></div>' : ""}
          ${isHost && roomState.npcStepInProgress ? '<p class="turn-banner waiting">NPC lining up a swing…</p>' : ""}
          ${nextReady ? `${matchSettingsMarkup(roomState.nextMatchSettings, "Next match format")}${winnerChoiceMarkup(roomState.pendingMatches[0]?.playerIds || [])}<button id="next-match" class="button button-primary">Start next match</button>` : ""}
          ${isHost && match ? '<button id="restart-match" class="button button-secondary">Restart current match</button>' : ""}
          ${roomState.phase === "complete" ? '<p class="champion">Tournament complete</p>' : ""}
          <p id="game-message" class="toast" role="status">${escapeHtml(flashMessage)}</p>
        </section>
      </div>
      <section class="card bracket">
        <div class="topline"><div><p class="eyebrow">Tournament progress</p><h3>Double-elimination bracket</h3></div><div class="bracket-actions"><span class="status-pill">${roomState.history.length} matches complete</span>${isHost && roomState.phase !== "lobby" ? '<button id="restart-tournament" class="button button-secondary">Restart tournament</button>' : ""}</div></div>
        ${bracket}
      </section>`;
  }

  function playerLobbyMarkup() {
    const player = findPlayer(playerId);
    practiceState ||= {
      hits: 0,
      message: "Practice swings won't affect your stats or tournament.",
      position: 0,
      direction: 1,
      bent: false,
      bonus: false,
      beers: 0,
      drunk: 0,
      pendingDrink: false,
      rollingBeer: false,
      beerRoll: null,
      constitution: findPlayer(playerId)?.constitution ?? 3,
      stats: randomPracticeStats()
    };
    return `<section class="card">
      <h2>You are in</h2>
      <p class="muted">Waiting for the host to start. You can set your stats until the tournament begins.</p>
      <p class="help">Participants joined: ${roomState.players.length}/32</p>
      ${characterImagePicker(player)}
      <form id="my-stats-form">
        <div class="stats-grid">
          ${statSelect(player, "strength", "Strength")}
          ${statSelect(player, "dexterity", "Dexterity")}
          ${statSelect(player, "constitution", "Constitution")}
          ${statSelect(player, "wisdom", "Wisdom")}
        </div>
        <button class="button button-secondary" type="submit">Save my stats</button>
        <p id="player-stats-message" class="toast" role="status"></p>
      </form>
      ${practiceMarkup()}
    </section>`;
  }

  function randomPracticeStats() {
    return {
      strength: Math.floor(Math.random() * 6),
      dexterity: Math.floor(Math.random() * 6),
      wisdom: Math.floor(Math.random() * 6),
      drunk: practiceState?.drunk || 0,
      constitution: practiceState?.constitution ?? 3
    };
  }

  function practiceMarkup() {
    practiceState.constitution = findPlayer(playerId)?.constitution ?? practiceState.constitution;
    practiceState.stats.drunk = practiceState.drunk;
    practiceState.stats.constitution = practiceState.constitution;
    const stats = calculateSwingStats(practiceState.stats, practiceState.bent, practiceState.bonus);
    const targetStart = 50 - stats.width / 2;
    const dangerWidth = Math.min(stats.bendWidth, targetStart);
    const rightDangerStart = targetStart + stats.width;
    const rightDangerWidth = Math.min(stats.bendWidth, 100 - rightDangerStart);
    return `<section class="practice-game" aria-label="Solo swing practice">
      <h3>Solo swing practice</h3>
      <p class="help">Practice unlimited swings with random Strength, Dexterity, and Wisdom. Strength increases the Hit Zone, Dexterity lowers the speed of the hammer bar, Constitution improves your chances to resist becoming drunk, and Wisdom slows the hammer bar in the hit zone.</p>
      <p class="help">Landing a hit in the very center grants a critical hit, giving you 2 hits. When the nail is bent, it increases the difficulty of hitting it next round. You may spend a turn to straighten the nail, which makes your next hit far easier. Missing the nail entirely causes you to drink a beer, forcing you to roll a constitution save to prevent becoming intoxicated. Becoming intoxicated makes hits more difficult for the rest of the match. You can use your turn to sober up, reducing your intoxciation level by your CON/2.</p>
      <p class="practice-stats">Practice stats · STR ${practiceState.stats.strength} · DEX ${practiceState.stats.dexterity} · CON ${practiceState.constitution} · WIS ${practiceState.stats.wisdom}${practiceState.bent ? " · Nail bent" : ""}${practiceState.bonus ? " · Straightening bonus" : ""} · Beers ${practiceState.beers}${practiceState.drunk ? ` · Intoxicated x${practiceState.drunk}` : ""}</p>
      <div class="meter-scroll">
        <div class="target-label"><span>Miss</span><span>Bend</span><span>Hit zone</span><span>Bend</span><span>Miss</span></div>
        <div class="meter-frame practice-meter-frame ${practiceState.drunk ? "wobble" : ""}" style="--wiggle:${Math.min(12, 2 + practiceState.drunk * 2)}px;--wiggle-time:${Math.max(120, 280 - practiceState.drunk * 30)}ms">
        <div id="practice-hammer" class="hammer-marker" aria-hidden="true"><svg viewBox="0 0 40 24"><path class="hammer-handle" d="M1 14h27" /><rect class="hammer-head" x="26" y="3" width="12" height="20" rx="1" /></svg></div>
        <div class="practice-meter meter" data-speed="${stats.speed}" data-hit-width="${stats.width}" data-wisdom-slowdown="${stats.wisdomSlowdown}">
          <div class="bend-risk" style="left:${Math.max(0, targetStart - dangerWidth)}%;width:${dangerWidth}%"></div>
          <div class="target-zone" style="left:${targetStart}%;width:${stats.width}%"></div>
          <div class="bend-risk" style="left:${rightDangerStart}%;width:${rightDangerWidth}%"></div>
          ${stats.criticalWidth ? `<div class="bullseye-zone" style="left:${50 - stats.criticalWidth / 2}%;width:${stats.criticalWidth}%"></div>` : ""}
          <div id="practice-needle" class="needle" style="left:${practiceState.position}%"></div>
          </div>
        </div>
      </div>
      <div class="practice-controls">${practiceState.pendingDrink
        ? `<button id="practice-drink" class="button button-primary" ${practiceState.rollingBeer ? "disabled" : ""}>${practiceState.rollingBeer ? "Rolling d20…" : "Drink a Beer · roll d20"}</button>${practiceState.beerRoll !== null ? `<span class="practice-roll beer-die ${practiceState.rollingBeer ? "rolling" : ""}">${renderD20(practiceState.beerRoll)}</span>` : ""}`
        : `<button id="practice-swing" class="button button-primary">Swing <span class="key">SPACE BAR</span></button>${practiceState.bent ? '<button id="practice-straighten" class="button button-secondary">Straighten nail · uses turn</button>' : ""}${practiceState.drunk ? '<button id="practice-sober-up" class="button button-secondary">Sober Up · uses turn</button>' : ""}`}
        <strong id="practice-score">${practiceState.hits} hits</strong><button id="practice-reset" class="button button-secondary">Reset beers / intoxication</button></div>
      <p id="practice-message" class="toast" role="status">${escapeHtml(practiceState.message)}</p>
    </section>`;
  }

  function startPracticeMeter() {
    if (practiceFrame) cancelAnimationFrame(practiceFrame);
    const needle = document.querySelector("#practice-needle");
    if (!needle || !practiceState) {
      practiceFrame = null;
      practiceLastFrame = 0;
      return;
    }
    const meter = needle.closest(".practice-meter");
    const frame = needle.closest(".practice-meter-frame");
    const meterWidth = meter.clientWidth;
    const frameWidth = frame.clientWidth;
    const animate = (timestamp) => {
      const currentNeedle = document.querySelector("#practice-needle");
      if (!currentNeedle || !practiceState || practiceState.pendingDrink) {
        practiceFrame = null;
        practiceLastFrame = 0;
        return;
      }
      const elapsed = practiceLastFrame ? Math.min(100, timestamp - practiceLastFrame) : 0;
      practiceLastFrame = timestamp;
      let speed = Number(meter.dataset.speed);
      const hitWidth = Number(meter.dataset.hitWidth);
      const wisdomSlowdown = Number(meter.dataset.wisdomSlowdown);
      if (practiceState.position >= 50 - hitWidth / 2 && practiceState.position <= 50 + hitWidth / 2) {
        speed *= 1 - wisdomSlowdown;
      }
      practiceState.position += practiceState.direction * speed * elapsed / 1000;
      if (practiceState.position >= 100) {
        practiceState.position = 100;
        practiceState.direction = -1;
      } else if (practiceState.position <= 0) {
        practiceState.position = 0;
        practiceState.direction = 1;
      }
      setMarkerPosition(currentNeedle, meterWidth, practiceState.position);
      const hammer = document.querySelector("#practice-hammer");
      if (hammer) setMarkerPosition(hammer, frameWidth, practiceState.position, 0.8);
      practiceFrame = requestAnimationFrame(animate);
    };
    practiceFrame = requestAnimationFrame(animate);
  }

  function setMarkerPosition(marker, trackWidth, position, anchor = 0.5) {
    if (!marker || !trackWidth) return;
    const x = trackWidth * position / 100;
    if (marker.style.left && marker.style.left !== "0px" && marker.style.left !== "0") marker.style.left = "0";
    marker.style.transform = `translate3d(${x}px, 0, 0) translateX(-${anchor * 100}%)`;
  }

  function repaintPractice() {
    const practice = document.querySelector(".practice-game");
    if (!practice) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = practiceMarkup();
    practice.replaceWith(wrapper.firstElementChild);
    bindPracticeControls();
  }

  function bindPracticeControls() {
    document.querySelector("#practice-swing")?.addEventListener("click", () => {
      if (practiceFrame) cancelAnimationFrame(practiceFrame);
      const stats = calculateSwingStats(practiceState.stats, practiceState.bent, practiceState.bonus);
      const distance = Math.abs(practiceState.position - 50);
      const result = stats.criticalWidth > 0 && distance <= stats.criticalWidth / 2 ? "bullseye"
        : distance <= stats.width / 2 ? "hit"
          : distance <= stats.width / 2 + stats.bendWidth ? "bent"
            : "miss";
      if (result === "bullseye") {
        practiceState.hits += 2;
        practiceState.message = "Bullseye! Two practice hits.";
        playSound("hit");
        practiceState.bonus = false;
      } else if (result === "hit") {
        practiceState.hits += 1;
        practiceState.message = "Hit! Practice hit added.";
        playSound("hit");
        practiceState.bonus = false;
      } else if (result === "bent") {
        practiceState.message = "Close miss! The nail bent; the hit zone is smaller.";
        playSound("bent");
        practiceState.bent = true;
        practiceState.bonus = false;
      } else {
        practiceState.message = "Full miss! Drink a beer and roll a Constitution save.";
        playSound("miss");
        practiceState.bonus = false;
        practiceState.pendingDrink = true;
        practiceState.beerRoll = null;
      }
      practiceState.stats = randomPracticeStats();
      practiceState.position = 0;
      practiceState.direction = 1;
      repaintPractice();
      startPracticeMeter();
    });
    document.querySelector("#practice-drink")?.addEventListener("click", () => {
      if (practiceState.rollingBeer || !practiceState.pendingDrink) return;
      practiceState.rollingBeer = true;
      practiceState.beers += 1;
      practiceState.beerRoll = Math.floor(Math.random() * 20) + 1;
      const roll = practiceState.beerRoll;
      const threshold = Math.min(25, 10 + practiceState.beers * 3);
      playSound("dice");
      repaintPractice();
      practiceBeerInterval = setInterval(() => {
        const die = document.querySelector(".practice-roll");
        if (die) die.innerHTML = renderD20(Math.floor(Math.random() * 20) + 1);
      }, 90);
      practiceBeerTimeout = setTimeout(() => {
        clearInterval(practiceBeerInterval);
        practiceBeerInterval = null;
        practiceBeerTimeout = null;
        const penalty = roll + practiceState.constitution < threshold;
        if (penalty) practiceState.drunk = Math.min(6, practiceState.drunk + 1);
        practiceState.stats.drunk = practiceState.drunk;
        practiceState.rollingBeer = false;
        practiceState.pendingDrink = false;
        practiceState.message = `Sobriety Check DC ${threshold}: rolled a ${roll + practiceState.constitution} (${roll}+${practiceState.constitution})`;
        repaintPractice();
      }, 1500);
    });
    document.querySelector("#practice-straighten")?.addEventListener("click", () => {
      practiceState.bent = false;
      practiceState.bonus = true;
      practiceState.message = "Nail straightened. The next hit zone matches Strength 5.";
      practiceState.position = 0;
      practiceState.direction = 1;
      repaintPractice();
    });
    document.querySelector("#practice-sober-up")?.addEventListener("click", () => {
      if (practiceState.drunk <= 0) return;
      practiceState.drunk -= 1;
      practiceState.stats.drunk = practiceState.drunk;
      practiceState.message = "You sobered up by one level. The action used your turn.";
      repaintPractice();
    });
    document.querySelector("#practice-reset")?.addEventListener("click", () => {
      practiceState.beers = 0;
      practiceState.drunk = 0;
      practiceState.pendingDrink = false;
      practiceState.rollingBeer = false;
      practiceState.beerRoll = null;
      clearInterval(practiceBeerInterval);
      clearTimeout(practiceBeerTimeout);
      practiceBeerInterval = null;
      practiceBeerTimeout = null;
      practiceState.stats.drunk = 0;
      practiceState.message = "Beer and intoxication levels reset.";
      repaintPractice();
    });
    startPracticeMeter();
  }

  function render() {
    if (!roomState) return;
    if (role === "host") {
      hostView.innerHTML = hostMarkup();
      hostView.classList.remove("hidden");
      playerView.classList.add("hidden");
      bindHostControls();
    } else {
      playerView.innerHTML = `
        <div class="view">
          <div class="topline"><div><p class="eyebrow">Room ${roomState.code}</p><h2>Welcome, ${escapeHtml(playerName(playerId))}</h2></div><span class="status-pill">Player</span></div>
          ${roomState.phase === "lobby" ? playerLobbyMarkup() : tournamentMarkup(false)}
        </div>`;
      playerView.classList.remove("hidden");
      hostView.classList.add("hidden");
      bindPlayerControls();
    }
    syncTurnTimer();
    renderHitEffect();
    renderSwingSound();
    renderConfetti();
  }

  function syncTurnTimer() {
    const match = roomState?.currentMatch;
    const activeId = match?.playerIds[match.turnIndex];
    const canTimeTurn = role === "player" && playerId === activeId &&
      !match?.pendingAdvance && !match?.pendingDrinkPlayerId &&
      !beerRollState?.rolling &&
      !(match?.suddenDeathActive && !match.suddenDeathBeerDrank?.[activeId]);
    if (!canTimeTurn) {
      clearInterval(turnTimerInterval);
      turnTimerInterval = null;
      turnTimerKey = null;
      turnTimerDeadline = 0;
      return;
    }
    const key = `${match.matchId}:${match.gameNumber}:${activeId}:${match.lastSwing?.count || 0}`;
    if (turnTimerKey !== key) {
      clearInterval(turnTimerInterval);
      turnTimerKey = key;
      turnTimerDeadline = Date.now() + 20_000;
      turnTimerInterval = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((turnTimerDeadline - Date.now()) / 1000));
        const display = document.querySelector("#turn-timer");
        if (display) display.textContent = remaining
          ? `Swing automatically in ${remaining}s`
          : "Time expired — swinging automatically…";
        if (!remaining) {
          const drinkButton = document.querySelector("#drink-beer");
          if (drinkButton && !drinkButton.disabled) {
            drinkButton.click();
            turnTimerDeadline = Date.now() + 2_000;
            return;
          }
          clearInterval(turnTimerInterval);
          turnTimerInterval = null;
          const swingButton = document.querySelector("#swing");
          if (swingButton && !swingButton.disabled) swingButton.click();
        }
      }, 200);
    }
  }

  function renderConfetti() {
    const layer = document.querySelector("#confetti-layer");
    if (!layer) return;
    if (roomState.phase !== "complete") {
      layer.replaceChildren();
      return;
    }
    if (layer.childElementCount) return;
    const colors = ["#f2c14e", "#e76f51", "#8ac926", "#4cc9f0", "#c77dff", "#fff0a6"];
    layer.innerHTML = Array.from({ length: 72 }, (_, index) => {
      const duration = 5 + (index * 7 % 60) / 10;
      const delay = (index * 13 % 70) / 10;
      const left = (index * 37 % 100);
      const drift = (index * 19 % 121) - 60;
      const spin = 360 + index * 41 % 720;
      const color = colors[index % colors.length];
      return `<span style="--duration:${duration}s;--delay:-${delay}s;--left:${left}%;--drift:${drift}px;--spin:${spin}deg;--color:${color}"></span>`;
    }).join("");
  }

  function bindHostControls() {
    if (roomState.currentMatch) startMeter();
    document.querySelector("#current-best-of")?.addEventListener("change", async (event) => {
      const response = await emitWithCallback("host:set-match-best-of", {
        code: roomCode,
        bestOf: Number(event.currentTarget.value)
      });
      if (!response?.ok) showToast(response?.error || "Could not change this match's series format.");
    });
    document.querySelector("#current-hits-to-win")?.addEventListener("change", async (event) => {
      const response = await emitWithCallback("host:set-match-hits-to-win", {
        code: roomCode,
        hitsToWin: Number(event.currentTarget.value)
      });
      if (!response?.ok) {
        showToast(response?.error || "Could not change the hit target.");
        render();
      }
    });
    document.querySelectorAll("[data-match-drunk]").forEach((input) => {
      input.addEventListener("change", async () => {
        const response = await emitWithCallback("host:set-match-drunk", {
          code: roomCode,
          playerId: input.dataset.matchDrunk,
          drunk: Number(input.value)
        });
        if (!response?.ok) showToast(response?.error || "Could not change intoxication.");
      });
    });
    document.querySelector("#start-tournament")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:start", {
        code: roomCode,
        winnerId: document.querySelector("#preselected-winner")?.value || undefined
      });
      if (!response?.ok) showToast(response?.error || "Could not start the tournament.");
    });
    document.querySelector("#next-match")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:next-match", {
        code: roomCode,
        winnerId: document.querySelector("#preselected-winner")?.value || undefined
      });
      if (!response?.ok) showToast(response?.error || "Could not start the next match.");
    });
    document.querySelector("#randomize-bracket")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:randomize-bracket", { code: roomCode });
      if (!response?.ok) showToast(response?.error || "Could not randomize the bracket.");
    });
    document.querySelector("#next-npc-turn")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:next-npc-turn", { code: roomCode });
      if (!response?.ok) showToast(response?.error || "Could not start the NPC turn.");
    });
    document.querySelector("#play-as-npc")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:play-as-npc", { code: roomCode });
      if (!response?.ok) showToast(response?.error || "Could not take control of the NPC turn.");
    });
    document.querySelector("#swing")?.addEventListener("click", swing);
    document.querySelector("#drink-beer")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:npc-action", { code: roomCode, action: "drink" });
      if (!response?.ok) showToast(response?.error || "Could not complete the beer check.");
    });
    document.querySelector("#host-straighten-npc")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:npc-action", { code: roomCode, action: "straighten" });
      if (!response?.ok) showToast(response?.error || "Could not straighten the NPC's nail.");
    });
    document.querySelector("#host-sober-up-npc")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:npc-action", { code: roomCode, action: "sober-up" });
      if (!response?.ok) showToast(response?.error || "Could not sober up the NPC.");
    });
    document.querySelector("#host-confirm-turn")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:confirm-turn", { code: roomCode });
      if (!response?.ok) showToast(response?.error || "Could not confirm the turn.");
    });
    document.querySelector("#award-match")?.addEventListener("click", async () => {
      const response = await emitWithCallback("host:award-match", {
        code: roomCode,
        winnerId: document.querySelector("#automatic-winner")?.value
      });
      if (!response?.ok) showToast(response?.error || "Could not award the match.");
    });
    document.querySelector("#restart-match")?.addEventListener("click", async () => {
      if (!confirm("Restart this match? Scores, beers, and drunkenness for both fighters will reset.")) return;
      const response = await emitWithCallback("host:restart-match", { code: roomCode });
      if (!response?.ok) showToast(response?.error || "Could not restart this match.");
    });
    document.querySelector("#restart-tournament")?.addEventListener("click", async () => {
      if (!confirm("Restart the tournament from the first round? Match results, wins, beers, and drunkenness will reset.")) return;
      const response = await emitWithCallback("host:restart-tournament", { code: roomCode });
      if (!response?.ok) showToast(response?.error || "Could not restart the tournament.");
    });
    document.querySelector("#add-npc-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const lines = String(form.get("entries") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const entries = [];
      for (const line of lines) {
        const parts = line.split(",").map((part) => part.trim());
        if (![4, 5].includes(parts.length) || !parts[0] || parts.slice(1).some((part) => !/^[0-5]$/.test(part))) {
          const error = document.querySelector("#host-error");
          if (error) error.textContent = `Invalid NPC line: "${line}". Use Name,Strength,Dexterity,Constitution[,Wisdom] (stats 0–5).`;
          return;
        }
        entries.push({
          name: parts[0],
          stats: { strength: Number(parts[1]), dexterity: Number(parts[2]), constitution: Number(parts[3]), wisdom: parts[4] === undefined ? 3 : Number(parts[4]) }
        });
      }
      const response = await emitWithCallback("host:add-npcs", { code: roomCode, entries });
      const error = document.querySelector("#host-error");
      if (error) error.textContent = response?.ok ? "" : response?.error || "Could not add the NPC.";
    });
    document.querySelector("#npc-match-mode")?.addEventListener("change", (event) => {
      socket.emit("host:update-setup", { code: roomCode, npcMatchMode: event.target.value });
    });
    document.querySelectorAll("[data-match-setting]").forEach((control) => {
      control.addEventListener("change", () => {
        const value = control.type === "checkbox" ? control.checked : Number(control.value);
        socket.emit("host:update-setup", { code: roomCode, [control.dataset.matchSetting]: value });
      });
    });
    document.querySelectorAll("[data-character-image]").forEach((button) => {
      button.addEventListener("click", async () => {
        const response = await emitWithCallback("host:update-setup", {
          code: roomCode,
          updates: [{
            id: button.dataset.player,
            characterImage: button.dataset.characterImage
          }]
        });
        if (!response?.ok) showToast(response?.error || "Could not update this character image.");
      });
    });
    document.querySelectorAll("[data-stat]").forEach((select) => {
      select.addEventListener("change", () => {
        const update = {
          id: select.dataset.player,
          [select.dataset.stat]: Number(select.value)
        };
        socket.emit("host:update-setup", { code: roomCode, updates: [update] });
      });
    });
    document.querySelectorAll("[data-move]").forEach((button) => {
      button.addEventListener("click", () => {
        const from = Number(button.closest(".participant-row").querySelector(".seed").textContent.slice(1)) - 1;
        const to = Number(button.dataset.move);
        const players = [...roomState.players];
        [players[from], players[to]] = [players[to], players[from]];
        socket.emit("host:update-setup", { code: roomCode, order: players.map((player) => player.id) });
      });
    });
    let draggedId = null;
    document.querySelectorAll(".draggable-participant").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        draggedId = row.dataset.playerId;
        row.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedId);
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging", "drop-target"));
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        row.classList.remove("drop-target");
        const sourceId = draggedId || event.dataTransfer.getData("text/plain");
        const players = [...roomState.players];
        const sourceIndex = players.findIndex((player) => player.id === sourceId);
        const targetIndex = players.findIndex((player) => player.id === row.dataset.playerId);
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
        const [dragged] = players.splice(sourceIndex, 1);
        players.splice(targetIndex, 0, dragged);
        socket.emit("host:update-setup", { code: roomCode, order: players.map((player) => player.id) });
      });
    });
  }

  function bindPlayerControls() {
    if (roomState.currentMatch) startMeter();
    if (roomState.phase === "lobby") bindPracticeControls();
    else {
      if (practiceFrame) cancelAnimationFrame(practiceFrame);
      practiceFrame = null;
      clearInterval(practiceBeerInterval);
      clearTimeout(practiceBeerTimeout);
      practiceBeerInterval = null;
      practiceBeerTimeout = null;
    }
    document.querySelector("#swing")?.addEventListener("click", swing);
    document.querySelector("#confirm-turn")?.addEventListener("click", async () => {
      const response = await emitWithCallback("game:confirm-turn", { code: roomCode });
      if (!response?.ok) showToast(response?.error || "Could not confirm the turn.");
    });
    document.querySelector("#straighten")?.addEventListener("click", async () => {
      const response = await emitWithCallback("game:action", { code: roomCode, action: "straighten" });
      if (!response?.ok) showToast(response?.error || "Could not straighten the nail.");
      else showToast("Nail straightened. Your turn is spent.");
    });
    document.querySelector("#sober-up")?.addEventListener("click", async () => {
      const response = await emitWithCallback("game:action", { code: roomCode, action: "sober-up" });
      if (!response?.ok) showToast(response?.error || "Could not sober up.");
      else showToast("You sobered up by one level. Your turn is spent.");
    });
    document.querySelector("#drink-beer")?.addEventListener("click", async () => {
      const response = await emitWithCallback("game:action", { code: roomCode, action: "drink" });
      if (!response?.ok) showToast(response?.error || "Could not complete the beer check.");
    });
    document.querySelectorAll("[data-character-image]").forEach((button) => {
      button.addEventListener("click", async () => {
        const response = await emitWithCallback("player:update-image", {
          code: roomCode,
          characterImage: button.dataset.characterImage
        });
        if (!response?.ok) showToast(response?.error || "Could not update your character image.");
      });
    });
    document.querySelector("#my-stats-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const stats = Object.fromEntries(
        [...event.currentTarget.querySelectorAll("[data-stat]")].map((select) => [select.dataset.stat, Number(select.value)])
      );
      const response = await emitWithCallback("player:update-stats", { code: roomCode, stats });
      const message = document.querySelector("#player-stats-message");
      if (message) message.textContent = response?.ok ? "Stats saved." : response?.error || "Could not save stats.";
    });
  }

  function renderHitEffect() {
    const effect = roomState.currentMatch?.hitEffect ||
      roomState.history.at(-1)?.hitEffect;
    if (!effect) return;
    const effectKey = `${effect.matchId}:${effect.count}`;
    if (effectKey === lastEffectKey) return;
    lastEffectKey = effectKey;
    const spark = document.querySelector("#hit-spark");
    if (!spark) return;
    spark.className = `hit-spark active ${effect.kind === "bullseye" ? "gold" : ""}`;
    void spark.offsetWidth;
  }

  function renderSwingSound() {
    const swing = roomState.currentMatch?.lastSwing || roomState.history.at(-1)?.lastSwing;
    if (!swing) return;
    const key = `${roomState.currentMatch?.matchId || roomState.history.at(-1)?.matchId}:${swing.count}`;
    if (key === lastSoundSwingKey) return;
    lastSoundSwingKey = key;
    playSound(swing.action === "bullseye" || swing.action === "hit" ? "hit" : swing.action);
  }

  function startMeter() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    const match = roomState.currentMatch;
    if (match?.pendingAdvance && !match.lastSwing) return;
    const needle = document.querySelector("#needle");
    const hammer = document.querySelector("#hammer");
    const meter = needle?.closest(".meter");
    const frame = hammer?.closest(".meter-frame");
    const meterWidth = meter?.clientWidth;
    const frameWidth = frame?.clientWidth;
    const heldPosition = match?.pendingAdvance || match?.pendingDrinkPlayerId
      ? match.lastSwing?.position
      : null;
    if (Number.isFinite(heldPosition)) {
      const swungPlayer = findPlayer(match.lastSwing?.playerId);
      const swingKey = `${match.matchId}:${match.lastSwing?.count}`;
      if (needle && swungPlayer?.isNpc && heldSwingAnimationKey !== swingKey) {
        heldSwingAnimationKey = swingKey;
        const fromPosition = markerPosition;
        setMarkerPosition(needle, meterWidth, fromPosition);
        needle.style.transition = "none";
        requestAnimationFrame(() => {
          needle.style.transition = "transform 550ms cubic-bezier(.18,.7,.25,1)";
          setMarkerPosition(needle, meterWidth, heldPosition);
          if (hammer) {
            hammer.style.transition = "transform 550ms cubic-bezier(.18,.7,.25,1)";
            setMarkerPosition(hammer, frameWidth, heldPosition, 0.8);
          }
        });
        markerPosition = heldPosition;
      } else {
        markerPosition = heldPosition;
        if (needle) {
          needle.style.transition = "none";
          setMarkerPosition(needle, meterWidth, heldPosition);
        }
        if (hammer) {
          hammer.style.transition = "none";
          setMarkerPosition(hammer, frameWidth, heldPosition, 0.8);
        }
      }
      return;
    }
    const activeId = match?.playerIds[match.turnIndex];
    const activePlayer = findPlayer(activeId);
    const waitingForNpcStart = Boolean(
      activePlayer?.isNpc &&
      !roomState.npcStepInProgress &&
      !roomState.npcManualTurnId
    );
    const waitingForDrinkRoll = Boolean(
      beerRollState?.rolling &&
      match?.lastDrink?.playerId === activeId
    );
    const waitingForSuddenDeathDrink = Boolean(
      match?.suddenDeathActive &&
      !match.suddenDeathBeerDrank?.[activeId]
    );
    if (match?.pendingAdvance || match?.pendingDrinkPlayerId || waitingForNpcStart ||
        waitingForDrinkRoll || waitingForSuddenDeathDrink) {
      markerPosition = 0;
      markerDirection = 1;
      lastFrame = 0;
      if (needle) {
        needle.style.transition = "none";
        setMarkerPosition(needle, meterWidth, markerPosition);
      }
      if (hammer) {
        hammer.style.transition = "none";
        setMarkerPosition(hammer, frameWidth, markerPosition, 0.8);
      }
      return;
    }
    heldSwingAnimationKey = null;
    markerPosition = 0;
    markerDirection = 1;
    lastFrame = 0;
    needle.style.transition = "none";
    if (hammer) hammer.style.transition = "none";
    const animate = (time) => {
      if (!needle || !meter) return;
      const delta = lastFrame ? Math.min((time - lastFrame) / 1000, 0.1) : 0;
      lastFrame = time;
      let speed = Number(meter.dataset.speed) || 162.5;
      const hitWidth = Number(meter.dataset.hitWidth) || 0;
      const wisdomSlowdown = Number(meter.dataset.wisdomSlowdown) || 0;
      if (markerPosition >= 50 - hitWidth / 2 && markerPosition <= 50 + hitWidth / 2) {
        speed *= 1 - wisdomSlowdown;
      }
      markerPosition += markerDirection * delta * speed;
      if (markerPosition >= 100) { markerPosition = 100; markerDirection = -1; }
      if (markerPosition <= 0) { markerPosition = 0; markerDirection = 1; }
      setMarkerPosition(needle, meterWidth, markerPosition);
      if (hammer) setMarkerPosition(hammer, frameWidth, markerPosition, 0.8);
      animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
  }

  async function swing() {
    const button = document.querySelector("#swing");
    if (!button || button.disabled) return;
    button.disabled = true;
    const match = roomState.currentMatch;
    const actingId = role === "host" ? roomState.npcManualTurnId : playerId;
    const player = findPlayer(actingId);
    if (!player) {
      button.disabled = false;
      return;
    }
    const isBent = match.bentIds.includes(actingId);
    const hasBonus = match.bonusIds.includes(actingId);
    const { width, criticalWidth, bendWidth } = calculateSwingStats(player, isBent, hasBonus, match.suddenDeathActive);
    const distance = Math.abs(markerPosition - 50);
    const action = !match.suddenDeathActive && criticalWidth > 0 && distance <= criticalWidth / 2
      ? "bullseye"
      : distance <= width / 2
        ? "hit"
        : distance <= width / 2 + bendWidth
          ? "bent"
          : "miss";
    if (animationFrame) cancelAnimationFrame(animationFrame);
    const event = role === "host" ? "host:npc-action" : "game:action";
    const response = await emitWithCallback(event, { code: roomCode, action, position: markerPosition });
    if (!response?.ok) showToast(response?.error || "Could not submit your swing.");
  }

  document.querySelector("#create-room").addEventListener("click", createRoom);
  document.querySelector("#join-form").addEventListener("submit", joinRoom);
  document.querySelector("#room-code").addEventListener("input", updateRejoinButton);
  document.querySelector("#rejoin-game").addEventListener("click", () => {
    const code = document.querySelector("#room-code").value;
    const saved = savedReconnect(code);
    if (saved) rejoinRoom(code, saved.token);
  });
  try {
    document.querySelector("#room-code").value = localStorage.getItem("hammerschlagen-last-room") || "";
  } catch {
    showError("Browser storage is unavailable, so saved rejoin is disabled.");
  }
  updateRejoinButton();
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    const practiceButtonFocused = event.target instanceof HTMLElement && event.target.id === "practice-swing";
    if (event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) ||
          event.target.tagName === "BUTTON" && !practiceButtonFocused)) return;
    if (role === "player" && roomState?.phase === "lobby" &&
        document.querySelector("#practice-swing")) {
      const practiceDrinkButton = document.querySelector("#practice-drink");
      if (practiceDrinkButton && !practiceDrinkButton.disabled) {
        event.preventDefault();
        practiceDrinkButton.click();
        return;
      }
      event.preventDefault();
      document.querySelector("#practice-swing").click();
      return;
    }
    const drinkButton = document.querySelector("#drink-beer");
    if (drinkButton && !drinkButton.disabled) {
      event.preventDefault();
      drinkButton.click();
      return;
    }
    const endTurnButton = role === "host"
      ? document.querySelector("#host-confirm-turn")
      : document.querySelector("#confirm-turn");
    if (endTurnButton && !endTurnButton.disabled) {
      event.preventDefault();
      endTurnButton.click();
      return;
    }
    if (role === "host" && roomState?.npcManualTurnId) {
      if (document.querySelector("#swing") && !document.querySelector("#swing").disabled) {
        event.preventDefault();
        swing();
      }
      return;
    }
    if (role !== "player") return;
    if (document.querySelector("#swing") && !document.querySelector("#swing").disabled) {
      event.preventDefault();
      swing();
    }
  });
  socket.on("room:state", (state) => {
    if (state.code !== roomCode) return;
    roomState = state;
    render();
  });
  socket.on("connect", () => {
    if (role === "player" && roomCode && reconnectToken) rejoinRoom();
  });
  socket.on("disconnect", () => {
    if (role === "player") showToast("Disconnected. Reconnecting to the room…");
  });
  socket.on("connect_error", () => {
    if (role === "player") showToast("Lost connection to the game server. Rejoining is available when it reconnects.");
    else showError("Lost connection to the game server. Refresh to reconnect.");
  });
})();
