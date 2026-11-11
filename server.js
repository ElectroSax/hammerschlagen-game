const express = require("express");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomInt, randomUUID } = require("node:crypto");
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
  claimNpcCharacter,
  createBackup,
  createPlayer,
  createRoom,
  confirmTurn,
  makeRoomCode,
  prepareNextMatch,
  publicState,
  randomizeBracket,
  rerollLuckyBullseye,
  resolveCurrentMatch,
  restartCurrentMatch,
  resetTournamentToLobby,
  restoreBackup,
  setMatchBestOf,
  setMatchHitsToWin,
  setParticipantNpcStatus,
  setPlayerStats,
  seedTournament,
  startNextMatch
} = require("./game");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const rooms = new Map();
const npcTimers = new Map();
const pendingGuests = new Map();
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
  return {
    ...publicState(room),
    characterImages,
    pendingPlayerCount: pendingGuestSockets(room).size
  };
}

function pendingGuestSockets(room) {
  let guests = pendingGuests.get(room.code);
  if (!guests) {
    guests = new Set();
    pendingGuests.set(room.code, guests);
  }
  return guests;
}

function broadcast(room) {
  io.to(room.code).emit("room:state", roomState(room));
}

function hostOnly(socket, room) {
  return room && room.hostId === socket.id;
}

function validFirstRoundMatchups(matchups, players) {
  const playerIds = new Set(players.map((player) => player.id));
  const flattened = Array.isArray(matchups) ? matchups.flat() : [];
  return Array.isArray(matchups) &&
    matchups.length === Math.ceil(players.length / 2) &&
    matchups.every((matchup) =>
      Array.isArray(matchup) &&
      matchup.length === 2 &&
      matchup.every((id) => id === null || typeof id === "string" && playerIds.has(id)) &&
      !(matchup[0] === null && matchup[1] === null)
    ) &&
    flattened.filter((id) => id === null).length === players.length % 2 &&
    flattened.filter((id) => id !== null).length === playerIds.size &&
    new Set(flattened.filter((id) => id !== null)).size === playerIds.size;
}

function removeLobbyParticipant(room, participantId) {
  const index = room.players.findIndex((player) => player.id === participantId);
  if (index < 0) return false;
  const [participant] = room.players.splice(index, 1);
  room.firstRoundMatchups = null;
  if (!participant.isNpc && participant.socketId) {
    const participantSocket = io.sockets.sockets.get(participant.socketId);
    if (participantSocket) {
      participantSocket.emit("participant:removed", { code: room.code, name: participant.name });
      participantSocket.leave(room.code);
      participantSocket.data.playerId = null;
      delete participantSocket.data.roomCode;
    }
  }
  return true;
}

function playerForSocket(room, socket) {
  if (!room || socket.data.roomCode !== room.code || !socket.data.playerId) return null;
  const player = room.players.find((entry) => entry.id === socket.data.playerId);
  return player?.socketId === socket.id ? player : null;
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

  socket.on("host:backup", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room)) {
      callback?.({ ok: false, error: "Only the host can export a tournament backup." });
      return;
    }
    callback?.({ ok: true, backup: createBackup(room) });
  });

  socket.on("host:restore", ({ backup } = {}, callback) => {
    let code;
    do {
      code = makeRoomCode();
    } while (rooms.has(code));
    const restored = restoreBackup(backup, socket.id, code);
    if (!restored.ok) {
      callback?.(restored);
      return;
    }
    const room = restored.room;
    rooms.set(code, room);
    socket.join(code);
    callback?.({ ok: true, state: roomState(room) });
    broadcast(room);
    scheduleNpcTurn(room);
  });

  socket.on("player:enter-room", ({ code } = {}, callback) => {
    const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
    const room = rooms.get(normalizedCode);
    if (!room) {
      callback?.({ ok: false, error: "Room not found. Check the code with your host." });
      return;
    }
    if (room.phase !== "lobby") {
      callback?.({ ok: false, error: "This tournament has already started." });
      return;
    }
    if (socket.data.playerId || playerForSocket(room, socket)) {
      callback?.({ ok: false, error: "This connection already has a player profile." });
      return;
    }
    const guests = pendingGuestSockets(room);
    if (!guests.has(socket.id) && room.players.length + guests.size >= MAX_PLAYERS) {
      callback?.({ ok: false, error: `This room already has ${MAX_PLAYERS} participants.` });
      return;
    }
    guests.add(socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    delete socket.data.playerId;
    callback?.({ ok: true, state: roomState(room) });
    broadcast(room);
  });

  socket.on("player:create-profile", ({ code, name, stats } = {}, callback) => {
    const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
    const normalizedName = validName(name);
    const room = rooms.get(normalizedCode);
    const guests = room ? pendingGuestSockets(room) : null;
    if (!room || socket.data.roomCode !== room.code || !guests?.has(socket.id)) {
      callback?.({ ok: false, error: "Enter the room before creating a player profile." });
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
    player.socketId = socket.id;
    player.connected = true;
    room.players.push(player);
    room.firstRoundMatchups = null;
    socket.data.playerId = player.id;
    guests.delete(socket.id);
    callback?.({ ok: true, state: roomState(room), playerId: player.id });
    broadcast(room);
  });

  socket.on("player:claim-npc", ({ code, npcId } = {}, callback) => {
    const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
    const room = rooms.get(normalizedCode);
    const guests = room ? pendingGuestSockets(room) : null;
    if (!room || socket.data.roomCode !== room.code || !guests?.has(socket.id)) {
      callback?.({ ok: false, error: "Enter the room before claiming an NPC." });
      return;
    }
    if (room.phase !== "lobby") {
      callback?.({ ok: false, error: "NPCs can only be claimed before the tournament starts." });
      return;
    }
    const npc = room.players.find((player) => player.id === npcId && player.isNpc);
    if (!npc) {
      callback?.({ ok: false, error: "That NPC is no longer available to claim." });
      return;
    }
    npc.isNpc = false;
    npc.socketId = socket.id;
    npc.connected = true;
    socket.data.playerId = npcId;
    guests.delete(socket.id);
    callback?.({ ok: true, state: roomState(room), playerId: npcId, name: npc.name });
    broadcast(room);
  });

  socket.on("player:rejoin", ({ code, name } = {}, callback) => {
    const normalizedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
    const normalizedName = validName(name);
    const room = rooms.get(normalizedCode);
    if (!room) {
      callback?.({ ok: false, error: "Room not found. Check the code with your host." });
      return;
    }
    if (!normalizedName) {
      callback?.({ ok: false, error: "Enter the participant name used to join this room." });
      return;
    }
    const player = room.players.find((entry) =>
      !entry.isNpc && entry.name.toLowerCase() === normalizedName.toLowerCase()
    );
    if (!player) {
      callback?.({ ok: false, error: "No player with that name was found in this room." });
      return;
    }
    if (player.connected && player.socketId && io.sockets.sockets.has(player.socketId)) {
      callback?.({ ok: false, error: "That player is already connected to the room." });
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
    if (room.players.length + pendingGuestSockets(room).size + entries.length > MAX_PLAYERS) {
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
      normalizedEntries.push({
        name,
        stats,
        characterImage: typeof entry.characterImage === "string" && characterImages.includes(entry.characterImage)
          ? entry.characterImage
          : defaultCharacterImage
      });
    }
    const names = normalizedEntries.map((entry) => entry.name.toLowerCase());
    if (new Set(names).size !== names.length ||
        names.some((name) => room.players.some((player) => player.name.toLowerCase() === name))) {
      callback?.({ ok: false, error: "NPC names must be unique within the room." });
      return;
    }

    normalizedEntries.forEach(({ name, stats, characterImage }) => {
      const npc = createPlayer(`npc-${randomUUID()}`, name, true);
      setPlayerStats(npc, stats);
      npc.characterImage = characterImage;
      room.players.push(npc);
    });
    room.firstRoundMatchups = null;
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:remove-npc", ({ code, npcId } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "lobby") {
      callback?.({ ok: false, error: "Only the host can remove NPCs before the tournament starts." });
      return;
    }
    const npcIndex = room.players.findIndex((player) => player.id === npcId && player.isNpc);
    if (npcIndex < 0) {
      callback?.({ ok: false, error: "That NPC is no longer available to remove." });
      return;
    }
    room.players.splice(npcIndex, 1);
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:remove-participant", ({ code, playerId } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "lobby") {
      callback?.({ ok: false, error: "Only the host can remove participants before the tournament starts." });
      return;
    }
    if (!removeLobbyParticipant(room, playerId)) {
      callback?.({ ok: false, error: "That participant is no longer available to remove." });
      return;
    }
    callback?.({ ok: true });
    broadcast(room);
  });

  socket.on("host:update-setup", ({ code, order, updates, firstRoundMatchups, npcMatchMode, hitsToWin, bestOf, skipNpcOnly, tournamentFormat } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room)) {
      callback?.({ ok: false, error: "Only the host can change tournament setup." });
      return;
    }
    if (firstRoundMatchups !== undefined &&
        (room.phase !== "lobby" || !validFirstRoundMatchups(firstRoundMatchups, room.players))) {
      callback?.({ ok: false, error: "The first-round matchups must include every participant exactly once and one bye for an odd-sized bracket." });
      return;
    }
    const imageUpdates = Array.isArray(updates)
      ? updates.filter((update) => update?.characterImage !== undefined)
      : [];
    if (imageUpdates.some((update) => !characterImages.includes(update.characterImage))) {
      callback?.({ ok: false, error: "Choose a character image from the available images." });
      return;
    }
    const nameUpdates = Array.isArray(updates)
      ? updates.filter((update) => update?.name !== undefined)
      : [];
    if (nameUpdates.length) {
      if (room.phase !== "lobby") {
        callback?.({ ok: false, error: "Participant names can only be changed before the tournament starts." });
        return;
      }
      const namesById = new Map();
      for (const update of nameUpdates) {
        const name = validName(update.name);
        if (!room.players.some((player) => player.id === update.id) || !name) {
          callback?.({ ok: false, error: "Choose a participant and enter a valid name." });
          return;
        }
        namesById.set(update.id, name);
      }
      const finalNames = room.players.map((player) =>
        (namesById.get(player.id) || player.name).toLowerCase()
      );
      if (new Set(finalNames).size !== finalNames.length) {
        callback?.({ ok: false, error: "Participant names must be unique within the room." });
        return;
      }
    }
    if (tournamentFormat !== undefined) {
      if (room.phase !== "lobby" || !["single", "double"].includes(tournamentFormat)) {
        callback?.({ ok: false, error: "Choose single or double elimination before the tournament starts." });
        return;
      }
      room.tournamentFormat = tournamentFormat;
    }

    if (room.phase === "lobby" && Array.isArray(order) && order.length === room.players.length) {
      const orderSet = new Set(order);
      if (orderSet.size === room.players.length && room.players.every((player) => orderSet.has(player.id))) {
        room.players.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
        room.firstRoundMatchups = null;
      }
    }
    if (firstRoundMatchups !== undefined) {
      room.firstRoundMatchups = firstRoundMatchups.map((matchup) => [...matchup]);
    }

    if (Array.isArray(updates)) {
      updates.forEach((update) => {
        const player = room.players.find((entry) => entry.id === update?.id);
        if (!player) return;
        if (update.name !== undefined && room.phase === "lobby") {
          player.name = validName(update.name);
        }
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

  socket.on("player:claim-character", ({ code, npcId } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    const player = playerForSocket(room, socket);
    if (!room || room.phase !== "lobby" || !player || player.isNpc) {
      callback?.({ ok: false, error: "Only a joined player can claim a character before the tournament starts." });
      return;
    }
    if (!claimNpcCharacter(room, player.id, npcId)) {
      callback?.({ ok: false, error: "That NPC is no longer available to claim." });
      return;
    }
    const claimedNpc = room.players.find((participant) => participant.id === npcId);
    socket.data.playerId = npcId;
    callback?.({ ok: true, name: claimedNpc.name, playerId: npcId });
    broadcast(room);
  });

  socket.on("host:set-participant-type", ({ code, playerId, isNpc } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room)) {
      callback?.({ ok: false, error: "Only the host can change participant types." });
      return;
    }
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player || typeof isNpc !== "boolean") {
      callback?.({ ok: false, error: "Choose a participant and a valid participant type." });
      return;
    }
    if (player.isNpc === isNpc) {
      callback?.({ ok: true });
      return;
    }

    clearNpcTimer(room);
    if (isNpc) {
      const participantSocket = player.socketId && io.sockets.sockets.get(player.socketId);
      if (participantSocket) {
        participantSocket.data.playerId = null;
        participantSocket.leave(room.code);
        participantSocket.emit("participant:switched-to-npc", {
          code: room.code,
          name: player.name
        });
      }
      player.socketId = null;
      player.connected = false;
    } else {
      player.socketId = null;
      player.connected = false;
    }
    setParticipantNpcStatus(room, player.id, isNpc);
    callback?.({ ok: true });
    broadcast(room);
    scheduleNpcTurn(room);
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
    if (pendingGuestSockets(room).size) {
      callback?.({ ok: false, error: "Every guest must create a player profile before the tournament can start." });
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

  socket.on("host:coin-flip-match", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "tournament" || !room.currentMatch) {
      callback?.({ ok: false, error: "There is no active match to award." });
      return;
    }
    const coin = randomInt(0, 2);
    const winnerId = room.currentMatch.playerIds[coin];
    clearNpcTimer(room);
    room.npcStepRequired = false;
    room.npcStepInProgress = false;
    room.npcManualTurnId = null;
    if (!awardMatchToWinner(room, winnerId)) {
      callback?.({ ok: false, error: "Could not award the match to the selected participant." });
      return;
    }
    callback?.({ ok: true, winnerId, coin: coin === 0 ? "Heads" : "Tails" });
    broadcast(room);
  });

  socket.on("host:lucky-reroll", ({ code } = {}, callback) => {
    const room = rooms.get(typeof code === "string" ? code : "");
    if (!hostOnly(socket, room) || room.phase !== "tournament") {
      callback?.({ ok: false, error: "Only the host can reroll a lucky bullseye." });
      return;
    }
    const result = rerollLuckyBullseye(room);
    callback?.(result);
    if (result.ok) broadcast(room);
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
    if (!hostOnly(socket, room) || !resetTournamentToLobby(room)) {
      callback?.({ ok: false, error: "Only the host can restart a started tournament." });
      return;
    }
    clearNpcTimer(room);
    callback?.({ ok: true });
    broadcast(room);
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
      if (pendingGuestSockets(room).delete(socket.id)) broadcast(room);
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
