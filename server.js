const express = require("express");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } = require("node:crypto");
const { Server } = require("socket.io");
const {
  MAX_PLAYERS,
  MAX_HITS_TO_WIN,
  MAX_INTOXICATION,
  MAX_STAT,
  MIN_STAT,
  applyAction,
  applyHostNpcAction,
  applyNpcTurn,
  awardMatchToWinner,
  createPlayer,
  createRoom,
  confirmTurn,
  makeRoomCode,
  prepareNextMatch,
  publicState,
  randomizeBracket,
  resolveCurrentMatch,
  restartCurrentMatch,
  setMatchBestOf,
  setMatchHitsToWin,
  setPlayerStats,
  seedTournament,
  startNextMatch
} = require("./game");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const rooms = new Map();
const npcTimers = new Map();
const assetsDirectory = path.join(__dirname, "public", "assets");
const characterImages = fs.readdirSync(assetsDirectory)
  .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
  .sort((left, right) => left.localeCompare(right));
const defaultCharacterImage = "Generic NPC.png";
if (!characterImages.includes(defaultCharacterImage)) {
  throw new Error(`Missing default character image: ${path.join(assetsDirectory, defaultCharacterImage)}`);
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_request, response) => response.json({ ok: true }));

function roomState(room) {
  return { ...publicState(room), characterImages };
}

function broadcast(room) {
  io.to(room.code).emit("room:state", roomState(room));
}

function hostOnly(socket, room) {
  return room && room.hostId === socket.id;
}

function playerForSocket(room, socket) {
  if (!room || socket.data.roomCode !== room.code || !socket.data.playerId) return null;
  const player = room.players.find((entry) => entry.id === socket.data.playerId);
  return player?.socketId === socket.id ? player : null;
}

function hashReconnectToken(token) {
  return createHash("sha256").update(token).digest();
}

function reconnectTokenMatches(player, token) {
  if (typeof token !== "string" || !player?.reconnectTokenHash) return false;
  return timingSafeEqual(hashReconnectToken(token), Buffer.from(player.reconnectTokenHash, "hex"));
}

function hasNpcOnlyMatch(room) {
  return room.currentMatch?.playerIds.every((id) =>
    room.players.find((player) => player.id === id)?.isNpc
  );
}

function simulateNpcMatch(room) {
  let actions = 0;
  while (room.currentMatch && hasNpcOnlyMatch(room) && actions < 1000) {
    const result = applyNpcTurn(room);
    if (!result.ok) return false;
    if (room.currentMatch?.pendingAdvance) confirmTurn(room, null, true);
    actions += 1;
  }
  return actions < 1000;
}

function startPlayableMatch(room) {
  while (startNextMatch(room)) {
    if (!room.currentMatch.skipNpcOnly || !hasNpcOnlyMatch(room)) return true;
    if (!simulateNpcMatch(room)) return false;
    prepareNextMatch(room);
    return false;
  }
  return false;
}

function scheduleNpcTurn(room) {
  if (!room.currentMatch || room.currentMatch.pendingAdvance || room.npcManualTurnId || npcTimers.has(room.code)) return;
  const playerId = room.currentMatch.playerIds[room.currentMatch.turnIndex];
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player?.isNpc) return;

  if (room.npcMatchMode === "watch") {
    if (!room.npcStepRequired) {
      room.npcStepRequired = true;
      room.npcStepInProgress = false;
      broadcast(room);
    }
    return;
  }

  room.npcStepRequired = false;
  room.npcStepInProgress = true;
  const waitForBeerAnimation = room.currentMatch.suddenDeathActive &&
    room.currentMatch.suddenDeathBeerDrank[playerId] &&
    room.currentMatch.lastDrink?.playerId === playerId;
  const timer = setTimeout(() => {
    npcTimers.delete(room.code);
    if (!room.currentMatch) return;
    const result = applyNpcTurn(room);
    room.npcStepInProgress = false;
    if (result.ok) {
      broadcast(room);
      scheduleNpcTurn(room);
    }
  }, waitForBeerAnimation ? 1800 : 1500);
  npcTimers.set(room.code, timer);
}

function clearNpcTimer(room) {
  const timer = npcTimers.get(room.code);
  if (timer) clearTimeout(timer);
  npcTimers.delete(room.code);
  room.npcStepRequired = false;
  room.npcStepInProgress = false;
  room.npcManualTurnId = null;
}

function boundedStat(value) {
  if (typeof value === "string" && !/^[0-5]$/.test(value)) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= MIN_STAT && number <= MAX_STAT ? number : null;
}

function validStats(stats) {
  if (stats === undefined) return true;
  if (!stats || typeof stats !== "object") return false;
  return ["strength", "dexterity", "constitution"].every((stat) => boundedStat(stats[stat]) !== null) &&
    (stats.wisdom === undefined || boundedStat(stats.wisdom) !== null);
}

function validName(name) {
  return typeof name === "string" ? name.trim().slice(0, 32) : "";
}

io.on("connection", (socket) => {
  socket.on("host:create", (callback) => {
    let code;
    do {
      code = makeRoomCode();
    } while (rooms.has(code));

    const room = createRoom(code, socket.id);
    rooms.set(code, room);
    socket.join(code);
    callback?.({ ok: true, state: roomState(room) });
  });

  socket.on("player:join", ({ code, name, stats } = {}, callback) => {
    const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
    const normalizedName = validName(name);
    const room = rooms.get(normalizedCode);
    if (!room) {
      callback?.({ ok: false, error: "Room not found. Check the code with your host." });
      return;
    }
    if (room.phase !== "lobby") {
      callback?.({ ok: false, error: "This tournament has already started." });
      return;
    }
    if (!normalizedName) {
      callback?.({ ok: false, error: "Enter a player name." });
      return;
    }
    if (!validStats(stats)) {
      callback?.({ ok: false, error: "Strength, Dexterity, and Constitution must each be from 0 to 5; Wisdom, if provided, must also be from 0 to 5." });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      callback?.({ ok: false, error: `This room already has ${MAX_PLAYERS} participants.` });
      return;
    }
    if (room.players.some((player) => player.name.toLowerCase() === normalizedName.toLowerCase())) {
      callback?.({ ok: false, error: "That name is already in this room." });
      return;
    }

    const player = createPlayer(socket.id, normalizedName);
    setPlayerStats(player, stats);
    const reconnectToken = randomBytes(32).toString("base64url");
    player.reconnectTokenHash = hashReconnectToken(reconnectToken).toString("hex");
    player.socketId = socket.id;
    player.connected = true;
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    callback?.({ ok: true, state: roomState(room), playerId: player.id, reconnectToken });
    broadcast(room);
  });

  socket.on("player:rejoin", ({ code, reconnectToken } = {}, callback) => {
    const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
    const room = rooms.get(normalizedCode);
    if (!room) {
      callback?.({ ok: false, error: "Room not found. Check the code with your host." });
      return;
    }
    const player = room.players.find((entry) => reconnectTokenMatches(entry, reconnectToken));
    if (!player) {
      callback?.({ ok: false, error: "No participant matches this saved reconnect token." });
      return;
    }
    if (player.connected && player.socketId && io.sockets.sockets.has(player.socketId)) {
      callback?.({ ok: false, error: "This participant is already connected." });
      return;
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    callback?.({ ok: true, state: roomState(room), playerId: player.id });
    broadcast(room);
  });

  socket.on("host:add-npcs", ({ code, entries } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "lobby") {
      callback?.({ ok: false, error: "Only the host can add NPCs before the tournament starts." });
      return;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      callback?.({ ok: false, error: "Add at least one NPC line." });
      return;
    }
    if (room.players.length + entries.length > MAX_PLAYERS) {
      callback?.({ ok: false, error: `A tournament can have at most ${MAX_PLAYERS} participants.` });
      return;
    }
    const normalizedEntries = [];
    for (const entry of entries) {
      const name = validName(entry?.name);
      const stats = entry?.stats;
      if (!name || !validStats(stats)) {
        callback?.({ ok: false, error: "Each NPC line must have a name and Strength, Dexterity, and Constitution from 0 to 5; Wisdom is optional and must be from 0 to 5." });
        return;
      }
      normalizedEntries.push({ name, stats });
    }
    const names = normalizedEntries.map((entry) => entry.name.toLowerCase());
    if (new Set(names).size !== names.length ||
        names.some((name) => room.players.some((player) => player.name.toLowerCase() === name))) {
      callback?.({ ok: false, error: "NPC names must be unique within the room." });
      return;
    }

    normalizedEntries.forEach(({ name, stats }) => {
      const npc = createPlayer(`npc-${randomUUID()}`, name, true);
      setPlayerStats(npc, stats);
      room.players.push(npc);
    });
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:update-setup", ({ code, order, updates, npcMatchMode, hitsToWin, bestOf, skipNpcOnly } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room)) {
      callback?.({ ok: false, error: "Only the host can change tournament setup." });
      return;
    }
    const imageUpdates = Array.isArray(updates)
      ? updates.filter((update) => update?.characterImage !== undefined)
      : [];
    if (imageUpdates.length && room.phase !== "lobby") {
      callback?.({ ok: false, error: "Character images can only be changed before the tournament starts." });
      return;
    }
    if (imageUpdates.some((update) => !characterImages.includes(update.characterImage))) {
      callback?.({ ok: false, error: "Choose a character image from the available images." });
      return;
    }

    if (room.phase === "lobby" && Array.isArray(order) && order.length === room.players.length) {
      const orderSet = new Set(order);
      if (orderSet.size === room.players.length && room.players.every((player) => orderSet.has(player.id))) {
        room.players.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
      }
    }

    if (Array.isArray(updates)) {
      updates.forEach((update) => {
        const player = room.players.find((entry) => entry.id === update?.id);
        if (!player) return;
        for (const stat of ["strength", "dexterity", "constitution", "wisdom"]) {
          const value = boundedStat(update[stat]);
          if (value === null) continue;
          const penalties = room.currentMatch?.statPenalties?.[player.id];
          const originalStats = room.currentMatch?.originalStats?.[player.id];
          if (originalStats && penalties && ["strength", "dexterity", "wisdom"].includes(stat)) {
            originalStats[stat] = value;
            player[stat] = Math.max(0, value - penalties[stat]);
          } else {
            player[stat] = value;
          }
        }
        if (update.characterImage !== undefined && characterImages.includes(update.characterImage)) {
          player.characterImage = update.characterImage;
        }
      });
    }
    const hasMatchSettings =
      hitsToWin !== undefined || bestOf !== undefined || skipNpcOnly !== undefined;
    if (hasMatchSettings && room.phase !== "lobby" && room.currentMatch) {
      callback?.({ ok: false, error: "Match format can only be changed before the next match starts." });
      return;
    }
    const targetSettings = room.phase === "lobby"
      ? room.defaultMatchSettings
      : room.nextMatchSettings;
    if (hitsToWin !== undefined) {
      const value = Number(hitsToWin);
      if (!Number.isInteger(value) || value < 1 || value > MAX_HITS_TO_WIN) {
        callback?.({ ok: false, error: `Hits to win must be from 1 to ${MAX_HITS_TO_WIN}.` });
        return;
      }
      targetSettings.hitsToWin = value;
    }
    if (bestOf !== undefined) {
      const value = Number(bestOf);
      if (![1, 3].includes(value)) {
        callback?.({ ok: false, error: "Best-of must be 1 or 3." });
        return;
      }
      targetSettings.bestOf = value;
    }
    if (skipNpcOnly !== undefined) {
      if (typeof skipNpcOnly !== "boolean") {
        callback?.({ ok: false, error: "NPC match skip must be true or false." });
        return;
      }
      targetSettings.skipNpcOnly = skipNpcOnly;
    }
    let rescheduleNpc = false;
    if (npcMatchMode === "watch" || npcMatchMode === "skip") {
      room.npcMatchMode = npcMatchMode;
      if (npcMatchMode === "skip") {
        room.npcStepRequired = false;
        rescheduleNpc = true;
      } else {
        clearNpcTimer(room);
        rescheduleNpc = true;
      }
    }

    callback?.({ ok: true });
    broadcast(room);
    if (rescheduleNpc) scheduleNpcTurn(room);
  });

  socket.on("host:set-match-best-of", ({ code, bestOf } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "tournament" || !room.currentMatch) {
      callback?.({ ok: false, error: "Only the host can change the format of an active match." });
      return;
    }
    const value = Number(bestOf);
    if (![1, 3].includes(value)) {
      callback?.({ ok: false, error: "Best-of must be 1 or 3." });
      return;
    }
    const result = setMatchBestOf(room, value);
    callback?.(result);
    if (!result.ok) return;
    if (result.winnerId) {
      clearNpcTimer(room);
    }
    broadcast(room);
    if (!result.winnerId) scheduleNpcTurn(room);
  });

  socket.on("host:set-match-hits-to-win", ({ code, hitsToWin } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "tournament" || !room.currentMatch) {
      callback?.({ ok: false, error: "Only the host can change the hit target of an active match." });
      return;
    }
    const value = Number(hitsToWin);
    if (!Number.isInteger(value) || value < 1 || value > MAX_HITS_TO_WIN) {
      callback?.({ ok: false, error: `Hits to win must be from 1 to ${MAX_HITS_TO_WIN}.` });
      return;
    }
    const result = setMatchHitsToWin(room, value);
    callback?.(result);
    if (!result.ok) return;
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("host:set-match-drunk", ({ code, playerId, drunk } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "tournament" ||
        !room.currentMatch?.playerIds.includes(playerId)) {
      callback?.({ ok: false, error: "Choose a participant in the active match." });
      return;
    }
    const value = Number(drunk);
    if (!Number.isInteger(value) || value < 0 || value > MAX_INTOXICATION) {
      callback?.({ ok: false, error: `Intoxication must be a whole number from 0 to ${MAX_INTOXICATION}.` });
      return;
    }
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) {
      callback?.({ ok: false, error: "The selected participant could not be found." });
      return;
    }
    player.drunk = value;
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("player:update-stats", ({ code, stats } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    const player = playerForSocket(room, socket);
    if (!room || room.phase !== "lobby" || !player || player.isNpc || !validStats(stats)) {
      callback?.({ ok: false, error: "You can change your stats before the tournament starts." });
      return;
    }
    setPlayerStats(player, stats);
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("player:update-image", ({ code, characterImage } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    const player = playerForSocket(room, socket);
    if (!room || room.phase !== "lobby" || !player || player.isNpc ||
        !characterImages.includes(characterImage)) {
      callback?.({ ok: false, error: "Choose an available character image before the tournament starts." });
      return;
    }
    player.characterImage = characterImage;
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:randomize-bracket", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || !randomizeBracket(room, () => randomInt(0, 1_000_000) / 1_000_000)) {
      callback?.({ ok: false, error: "The bracket can only be randomized before the tournament starts." });
      return;
    }
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:start", ({ code, winnerId } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "lobby") {
      callback?.({ ok: false, error: "Only the host can start a tournament." });
      return;
    }
    if (room.players.length < 2) {
      callback?.({ ok: false, error: "At least two participants must join before starting." });
      return;
    }
    if (winnerId && !room.players.slice(0, 2).some((player) => player.id === winnerId)) {
      callback?.({ ok: false, error: "The selected winner is not in the opening match." });
      return;
    }

    seedTournament(room);
    if (winnerId) {
      startNextMatch(room);
      resolveCurrentMatch(room, winnerId);
      startPlayableMatch(room);
    } else {
      startPlayableMatch(room);
    }
    callback?.({ ok: true });
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("host:next-match", ({ code, winnerId } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "tournament" || room.currentMatch) {
      callback?.({ ok: false, error: "The next match is not ready to start." });
      return;
    }
    if (winnerId) {
      prepareNextMatch(room);
      if (!room.pendingMatches[0]?.playerIds.includes(winnerId)) {
        callback?.({ ok: false, error: "The selected winner is not in the next match." });
        return;
      }
      startNextMatch(room);
      resolveCurrentMatch(room, winnerId);
      startPlayableMatch(room);
    } else {
      startPlayableMatch(room);
    }
    callback?.({ ok: true });
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("host:award-match", ({ code, winnerId } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "tournament" ||
        !room.currentMatch?.playerIds.includes(winnerId)) {
      callback?.({ ok: false, error: "Choose a participant in the active match." });
      return;
    }
    clearNpcTimer(room);
    room.npcStepRequired = false;
    room.npcStepInProgress = false;
    room.npcManualTurnId = null;
    if (!awardMatchToWinner(room, winnerId)) {
      callback?.({ ok: false, error: "Could not award the match to that participant." });
      return;
    }
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:next-npc-turn", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    const activeId = room?.currentMatch?.playerIds[room.currentMatch.turnIndex];
    const activePlayer = room?.players.find((entry) => entry.id === activeId);
    if (!hostOnly(socket, room) || !room.npcStepRequired || !activePlayer?.isNpc || npcTimers.has(room.code)) {
      callback?.({ ok: false, error: "There is no paused NPC turn to start." });
      return;
    }
    room.npcStepRequired = false;
    room.npcStepInProgress = true;
    const timer = setTimeout(() => {
      npcTimers.delete(room.code);
      if (!room.currentMatch) return;
      const result = applyNpcTurn(room);
      room.npcStepInProgress = false;
      if (result.ok) {
        broadcast(room);
        scheduleNpcTurn(room);
      }
    }, 1800);
    npcTimers.set(room.code, timer);
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:play-as-npc", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    const activeId = room?.currentMatch?.playerIds[room.currentMatch.turnIndex];
    const activePlayer = room?.players.find((entry) => entry.id === activeId);
    if (!hostOnly(socket, room) || !room.npcStepRequired || !activePlayer?.isNpc ||
        room.currentMatch.pendingAdvance || npcTimers.has(room.code)) {
      callback?.({ ok: false, error: "There is no ready NPC turn to play." });
      return;
    }
    room.npcStepRequired = false;
    room.npcManualTurnId = activeId;
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:npc-action", ({ code, action, position } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    const activeId = room?.currentMatch?.playerIds[room.currentMatch.turnIndex];
    if (!hostOnly(socket, room) || !room.npcManualTurnId || room.npcManualTurnId !== activeId) {
      callback?.({ ok: false, error: "The host is not controlling an NPC turn." });
      return;
    }
    const result = applyHostNpcAction(room, activeId, action, position);
    callback?.(result);
    if (!result.ok) return;
    if (result.outcome === "drink-before-swing") {
      broadcast(room);
      return;
    }
    room.npcManualTurnId = null;
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("host:confirm-turn", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room)) {
      callback?.({ ok: false, error: "Only the host can confirm this turn." });
      return;
    }
    const result = confirmTurn(room, null, true);
    callback?.(result);
    if (!result.ok) return;
    room.npcStepRequired = false;
    room.npcManualTurnId = null;
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("host:restart-match", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || !restartCurrentMatch(room)) {
      callback?.({ ok: false, error: "There is no active match to restart." });
      return;
    }
    clearNpcTimer(room);
    room.npcManualTurnId = null;
    callback?.({ ok: true });
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("host:restart-tournament", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase === "lobby") {
      callback?.({ ok: false, error: "Only the host can restart a started tournament." });
      return;
    }
    clearNpcTimer(room);
    room.npcManualTurnId = null;
    seedTournament(room);
    startPlayableMatch(room);
    callback?.({ ok: true });
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("game:action", ({ code, action, position } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!room || room.phase !== "tournament") {
      callback?.({ ok: false, error: "There is no active tournament." });
      return;
    }

    const player = playerForSocket(room, socket);
    if (!player) {
      callback?.({ ok: false, error: "Rejoin the room before taking a turn." });
      return;
    }
    const result = applyAction(room, player.id, action, Math.random, position);
    callback?.(result);
    if (result.ok) {
      broadcast(room);
      scheduleNpcTurn(room);
    }
  });

  socket.on("game:confirm-turn", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    const player = playerForSocket(room, socket);
    if (!player) {
      callback?.({ ok: false, error: "Rejoin the room before confirming your turn." });
      return;
    }
    const result = confirmTurn(room, player.id);
    callback?.(result);
    if (!result.ok) return;
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.find((entry) => entry.socketId === socket.id);
      if (player) {
        player.connected = false;
        player.socketId = null;
        broadcast(room);
      }
    }
  });
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";
httpServer.listen(port, host, () => {
  console.log(`Hammerschlagen is running on http://localhost:${port}`);
  console.log("Players on your network can connect to this computer's local IP address.");
});
