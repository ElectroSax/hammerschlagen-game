const MAX_PLAYERS = 32;
const HITS_TO_WIN = 3;
const MAX_HITS_TO_WIN = 10;
const MIN_STAT = 0;
const MAX_STAT = 5;
const MAX_INTOXICATION = 6;
let nextMatchId = 1;

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function createRoom(code, hostId) {
  return {
    code,
    hostId,
    phase: "lobby",
    players: [],
    currentMatch: null,
    pendingMatches: [],
    roundWinners: [],
    roundByes: [],
    roundNumber: 1,
    roundLabel: null,
    tournamentStage: "winners",
    winnersRoundNumber: 1,
    losersRoundNumber: 0,
    winnersEntrants: [],
    winnersByes: [],
    winnersStageWinners: [],
    winnersStageLosers: [],
    losersPool: [],
    losersStageWinners: [],
    losersStageByes: [],
    winnersChampionId: null,
    lowerChampionId: null,
    grandFinalReset: false,
    lastMatchStump: null,
    history: [],
    seedIds: [],
    championId: null,
    defaultMatchSettings: { hitsToWin: HITS_TO_WIN, bestOf: 1, skipNpcOnly: false },
    nextMatchSettings: { hitsToWin: HITS_TO_WIN, bestOf: 1, skipNpcOnly: false },
    npcMatchMode: "watch",
    npcStepRequired: false,
    npcStepInProgress: false,
    npcManualTurnId: null
  };
}

function createPlayer(id, name, isNpc = false) {
  return {
    id,
    name,
    isNpc,
    characterImage: "Generic NPC.png",
    strength: 3,
    dexterity: 3,
    constitution: 3,
    wisdom: 3,
    beersDrank: 0,
    drunk: 0,
    wins: 0,
    losses: 0
  };
}

function createMatch(round, playerIds, roundIndex = 1, settings = {}) {
  return {
    matchId: nextMatchId++,
    round,
    roundIndex,
    playerIds,
    scores: Object.fromEntries(playerIds.map((id) => [id, 0])),
    gameWins: Object.fromEntries(playerIds.map((id) => [id, 0])),
    suddenDeathWinners: [],
    hitsToWin: Math.min(MAX_HITS_TO_WIN, Math.max(1, Number(settings.hitsToWin) || HITS_TO_WIN)),
    bestOf: settings.bestOf || 1,
    gameNumber: 1,
    lane: settings.lane || "winners",
    skipNpcOnly: settings.skipNpcOnly === true,
    bentIds: [],
    bonusIds: [],
    hitEffect: null,
    hitEffectCount: 0,
    pendingDrinkPlayerId: null,
    pendingAdvance: null,
    lastSwing: null,
    lastDrink: null,
    gamePointId: null,
    suddenDeathActive: false,
    suddenDeathRound: {},
    suddenDeathBeerDrank: {},
    originalStats: {},
    statPenalties: {},
    swingCount: 0,
    turnIndex: 0
  };
}

function roundName(count) {
  if (count === 2) return "Final";
  if (count === 4) return "Semi-finals";
  if (count === 8) return "Quarter-finals";
  if (count === 16 || count === 32) return `Round of ${count}`;
  return "Opening round";
}

function queueRound(room, playerIds, lane, roundIndex, label) {
  room.pendingMatches = [];
  room.roundLabel = label;
  for (let index = 0; index + 1 < playerIds.length; index += 2) {
    const match = createMatch(label, playerIds.slice(index, index + 2), roundIndex);
    match.lane = lane;
    room.pendingMatches.push(match);
  }
}

function queueWinnersRound(room) {
  room.winnersStageWinners = [];
  room.winnersStageLosers = [];
  room.winnersByes = room.winnersEntrants.length % 2
    ? [room.winnersEntrants[room.winnersEntrants.length - 1]]
    : [];
  room.roundByes = [...room.winnersByes];
  queueRound(
    room,
    room.winnersEntrants,
    "winners",
    room.winnersRoundNumber,
    `Winners Round ${room.winnersRoundNumber}`
  );
}

function queueLosersRound(room) {
  const entrants = [...room.losersPool];
  room.losersStageWinners = [];
  room.losersStageByes = entrants.length % 2 ? [entrants[entrants.length - 1]] : [];
  room.roundByes = [...room.losersStageByes];
  room.losersPool = [];
  room.tournamentStage = "losers";
  room.losersRoundNumber += 1;
  room.roundNumber += 1;
  queueRound(room, entrants, "losers", room.losersRoundNumber, `Losers Round ${room.losersRoundNumber}`);
}

function queueGrandFinal(room) {
  const match = createMatch(
    room.grandFinalReset ? "Grand Final Reset" : "Grand Final",
    [room.winnersChampionId, room.lowerChampionId],
    room.roundNumber + 1
  );
  match.lane = "finals";
  room.pendingMatches = [match];
  room.tournamentStage = "finals";
  room.roundLabel = match.round;
}

function seedTournament(room) {
  if (room.currentMatch) restoreMatchStats(room, room.currentMatch);
  const ids = room.players.map((player) => player.id);
  room.seedIds = [...ids];
  room.phase = "tournament";
  room.currentMatch = null;
  room.pendingMatches = [];
  room.roundWinners = [];
  room.roundByes = [];
  room.roundNumber = 1;
  room.winnersRoundNumber = 1;
  room.losersRoundNumber = 0;
  room.tournamentStage = "winners";
  room.winnersEntrants = [...ids];
  room.winnersByes = [];
  room.winnersStageWinners = [];
  room.winnersStageLosers = [];
  room.losersPool = [];
  room.losersStageWinners = [];
  room.losersStageByes = [];
  room.winnersChampionId = null;
  room.lowerChampionId = null;
  room.grandFinalReset = false;
  room.lastMatchStump = null;
  room.history = [];
  room.championId = null;
  room.npcStepRequired = false;
  room.npcStepInProgress = false;
  room.npcManualTurnId = null;
  room.nextMatchSettings = { ...room.defaultMatchSettings };
  room.players.forEach((player) => {
    player.wins = 0;
    player.beersDrank = 0;
    player.drunk = 0;
  });
  room.players.forEach((player) => {
    player.losses = 0;
  });
  queueWinnersRound(room);
}

function advanceBracketStage(room) {
  if (room.tournamentStage === "winners") {
    const advancing = [...room.winnersStageWinners, ...room.winnersByes];
    room.losersPool.push(...room.winnersStageLosers);
    if (advancing.length === 1) {
      room.winnersChampionId = advancing[0];
      room.winnersEntrants = [];
    } else {
      room.winnersEntrants = advancing;
      room.winnersRoundNumber += 1;
    }
    queueLosersRound(room);
    return;
  }
  if (room.tournamentStage === "losers") {
    const advancing = [...room.losersStageWinners, ...room.losersStageByes];
    room.losersSurvivors = advancing;
    if (room.winnersChampionId) {
      if (advancing.length === 1) {
        room.lowerChampionId = advancing[0];
        queueGrandFinal(room);
      } else if (advancing.length === 0) {
        room.championId = room.winnersChampionId;
        room.phase = "complete";
      } else {
        room.losersPool = advancing;
        queueLosersRound(room);
      }
      return;
    }
    room.losersPool = advancing;
    queueWinnersRound(room);
    room.tournamentStage = "winners";
    return;
  }
  if (room.tournamentStage === "finals" && room.pendingMatches.length === 0) {
    room.championId = room.winnersChampionId;
    room.phase = "complete";
  }
}

function startNextMatch(room) {
  if (room.currentMatch || room.phase !== "tournament") return false;
  let safety = 0;
  while (room.pendingMatches.length === 0 && room.phase === "tournament" && safety++ < 10) {
    advanceBracketStage(room);
  }
  if (!room.pendingMatches.length || room.phase !== "tournament") return false;

  room.currentMatch = room.pendingMatches.shift();
  Object.assign(room.currentMatch, room.nextMatchSettings);
  room.currentMatch.hitsToWin = Math.min(
    MAX_HITS_TO_WIN,
    Math.max(1, Number(room.nextMatchSettings.hitsToWin) || HITS_TO_WIN)
  );
  room.nextMatchSettings.skipNpcOnly = false;
  room.lastMatchStump = null;
  room.currentMatch.playerIds.forEach((id) => {
    const player = room.players.find((entry) => entry.id === id);
    player.beersDrank = 0;
    room.currentMatch.originalStats[id] = Object.fromEntries(
      ["strength", "dexterity", "wisdom"].map((stat) => [stat, player[stat]])
    );
    room.currentMatch.statPenalties[id] = { strength: 0, dexterity: 0, wisdom: 0 };
  });
  return true;
}

function prepareNextMatch(room) {
  if (room.currentMatch || room.phase !== "tournament") return false;
  let safety = 0;
  while (room.pendingMatches.length === 0 && room.phase === "tournament" && safety++ < 10) {
    advanceBracketStage(room);
  }
  return room.pendingMatches.length > 0;
}

function resolveCurrentMatch(room, winnerId) {
  if (!room.currentMatch || !room.currentMatch.playerIds.includes(winnerId)) return false;
  finishMatch(room, winnerId);
  prepareNextMatch(room);
  return true;
}

function awardMatchToWinner(room, winnerId) {
  const match = room.currentMatch;
  if (!match || !match.playerIds.includes(winnerId)) return false;
  match.scores[winnerId] = match.hitsToWin;
  match.gameWins[winnerId] = Math.ceil(match.bestOf / 2);
  return resolveCurrentMatch(room, winnerId);
}

function advanceTurn(match) {
  match.turnIndex = (match.turnIndex + 1) % match.playerIds.length;
}

function finishMatch(room, winnerId) {
  const match = room.currentMatch;
  restoreMatchStats(room, match);
  const loserId = match.playerIds.find((id) => id !== winnerId);
  const loser = room.players.find((player) => player.id === loserId);
  if (loser) loser.losses += 1;
  const completed = {
    matchId: match.matchId,
    round: match.round,
    roundIndex: match.roundIndex,
    playerIds: [...match.playerIds],
    scores: { ...match.gameWins },
    finalScores: { ...match.scores },
    hitsToWin: match.hitsToWin,
    bestOf: match.bestOf,
    gameWins: { ...match.gameWins },
    suddenDeathWinners: [...match.suddenDeathWinners],
    lane: match.lane,
    losses: Object.fromEntries(match.playerIds.map((id) => [
      id,
      room.players.find((player) => player.id === id)?.losses || 0
    ])),
    winnerId,
    hitEffect: match.hitEffect ? { ...match.hitEffect } : null,
    lastSwing: match.lastSwing ? { ...match.lastSwing } : null
  };
  room.history.push(completed);
  room.lastMatchStump = {
    playerIds: [...match.playerIds],
    scores: { ...match.scores },
    gameWins: { ...match.gameWins },
    winnerId,
    hitsToWin: match.hitsToWin,
    bestOf: match.bestOf,
    gameNumber: match.gameNumber,
    bentIds: [...match.bentIds],
    beers: Object.fromEntries(match.playerIds.map((id) => [
      id,
      room.players.find((player) => player.id === id)?.beersDrank || 0
    ]))
  };
  const winner = room.players.find((player) => player.id === winnerId);
  winner.wins += 1;
  if (match.lane === "winners") {
    room.winnersStageWinners.push(winnerId);
    room.winnersStageLosers.push(loserId);
  } else if (match.lane === "losers") {
    room.losersStageWinners.push(winnerId);
  } else if (match.lane === "finals") {
    if (!room.grandFinalReset && winnerId === room.lowerChampionId) {
      room.winnersChampionId = loserId;
      room.grandFinalReset = true;
      room.currentMatch = null;
      room.pendingMatches = [];
      queueGrandFinal(room);
      return;
    }
    room.championId = winnerId;
    room.phase = "complete";
    room.currentMatch = null;
    return;
  }
  room.currentMatch = null;
  prepareNextMatch(room);
}

function restoreMatchStats(room, match) {
  if (!match?.originalStats) return;
  for (const [playerId, stats] of Object.entries(match.originalStats)) {
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) continue;
    for (const stat of ["strength", "dexterity", "wisdom"]) {
      if (Number.isInteger(stats[stat])) player[stat] = stats[stat];
    }
  }
}

function lowerHighestSuddenDeathStat(match, player) {
  const stats = match.originalStats[player.id];
  const penalties = match.statPenalties[player.id];
  if (!stats || !penalties) return;
  const stat = ["strength", "dexterity", "wisdom"]
    .filter((name) => player[name] > 0)
    .sort((left, right) => player[right] - player[left])[0];
  if (!stat) return;
  player[stat] -= 1;
  penalties[stat] += 1;
}

function awardGame(room, match, winnerId) {
  if (match.suddenDeathActive && !match.suddenDeathWinners.includes(winnerId)) {
    match.suddenDeathWinners.push(winnerId);
  }
  for (const id of match.playerIds) {
    const player = room.players.find((entry) => entry.id === id);
    if (player) player.drunk = Math.max(0, player.drunk - player.constitution - 1);
  }
  match.gameWins[winnerId] += 1;
  if (match.gameWins[winnerId] >= Math.ceil(match.bestOf / 2)) {
    finishMatch(room, winnerId);
    return "won";
  }
  match.gameNumber += 1;
  for (const id of match.playerIds) match.scores[id] = 0;
  match.bentIds = [];
  match.bonusIds = [];
  match.gamePointId = null;
  match.suddenDeathActive = false;
  match.suddenDeathRound = {};
  match.suddenDeathBeerDrank = {};
  match.turnIndex = (match.turnIndex + 1) % match.playerIds.length;
  return "game-won";
}

function setMatchBestOf(room, bestOf) {
  const match = room.currentMatch;
  if (!match || ![1, 3].includes(bestOf)) {
    return { ok: false, error: "Choose best-of 1 or best-of 3 for an active match." };
  }
  match.bestOf = bestOf;
  const seriesWinsNeeded = Math.ceil(bestOf / 2);
  const winnerId = match.playerIds.find((id) => match.gameWins[id] >= seriesWinsNeeded);
  if (winnerId) finishMatch(room, winnerId);
  return { ok: true, winnerId: winnerId || null };
}

function setMatchHitsToWin(room, hitsToWin) {
  const match = room.currentMatch;
  if (!match || !Number.isInteger(hitsToWin) || hitsToWin < 1 || hitsToWin > MAX_HITS_TO_WIN) {
    return { ok: false, error: `Choose a hit target from 1 to ${MAX_HITS_TO_WIN} for an active match.` };
  }
  const highestScore = Math.max(...match.playerIds.map((id) => match.scores[id]));
  if (hitsToWin < highestScore) {
    return { ok: false, error: `The hit target cannot be lower than the highest current score (${highestScore}).` };
  }
  match.hitsToWin = hitsToWin;
  if (match.suddenDeathActive) return { ok: true };

  const reachedIds = match.playerIds.filter((id) => match.scores[id] >= hitsToWin);
  if (reachedIds.length === 2) {
    match.gamePointId = null;
    match.suddenDeathActive = true;
    match.suddenDeathRound = {};
    match.suddenDeathBeerDrank = {};
  } else if (reachedIds.length === 1) {
    match.gamePointId = reachedIds[0];
    if (match.playerIds[match.turnIndex] === reachedIds[0] &&
        !match.pendingAdvance && !match.pendingDrinkPlayerId) advanceTurn(match);
  } else {
    match.gamePointId = null;
  }
  return { ok: true };
}

function recordBeer(player, match, random = Math.random, endsTurn = true) {
  player.beersDrank += 1;
  const roll = Math.floor(random() * 20) + 1;
  const threshold = Math.min(25, 10 + player.beersDrank * 3);
  const previousDrunk = player.drunk;
  const penalty = roll + player.constitution < threshold;
  if (penalty) player.drunk = Math.min(MAX_INTOXICATION, player.drunk + 1);
  match.lastDrink = {
    playerId: player.id,
    roll,
    constitution: player.constitution,
    threshold,
    penalty,
    beersDrank: player.beersDrank,
    previousDrunk,
    drunk: player.drunk
  };
  if (match.suddenDeathActive && !endsTurn) {
    match.suddenDeathBeerDrank[player.id] = true;
  } else {
    match.pendingDrinkPlayerId = null;
    match.pendingAdvance = { playerId: player.id, outcome: "miss" };
  }
  return { outcome: "drink", drink: { ...match.lastDrink } };
}

function applyAction(room, playerId, action, random = Math.random, swingPosition = null) {
  return applyTurnAction(room, playerId, action, random, swingPosition, false);
}

function applyHostNpcAction(room, playerId, action, swingPosition = null) {
  return applyTurnAction(room, playerId, action, Math.random, swingPosition, true);
}

function applyTurnAction(room, playerId, action, random, swingPosition, allowNpc) {
  const match = room.currentMatch;
  if (!match || match.pendingAdvance || match.playerIds[match.turnIndex] !== playerId) {
    return { ok: false, error: "It is not your turn." };
  }

  const player = room.players.find((entry) => entry.id === playerId);
  if (!player || player.isNpc !== allowNpc) {
    return { ok: false, error: allowNpc ? "The selected participant is not an NPC." : "NPC turns are controlled by the game." };
  }

  if (match.pendingDrinkPlayerId) {
    if (action !== "drink" || match.pendingDrinkPlayerId !== playerId) {
      return { ok: false, error: "Drink a beer to finish your turn." };
    }
    return { ok: true, ...recordBeer(player, match, random) };
  }

  if (action === "drink" && match.suddenDeathActive &&
      !match.suddenDeathBeerDrank[playerId]) {
    return { ok: true, ...recordBeer(player, match, random, false), outcome: "drink-before-swing" };
  }
  if (match.suddenDeathActive && !match.suddenDeathBeerDrank[playerId] &&
      ["hit", "bullseye", "bent", "miss"].includes(action)) {
    return { ok: false, error: "Drink a beer before swinging in sudden death." };
  }

  if (action === "sober-up") {
    if (match.suddenDeathActive) {
      return { ok: false, error: "You cannot sober up during sudden death." };
    }
    if (player.drunk <= 0) {
      return { ok: false, error: "You are not intoxicated." };
    }
    player.drunk -= 1;
    if (match.suddenDeathActive) match.suddenDeathRound[playerId] = false;
    if (allowNpc) {
      match.lastSwing = null;
      match.pendingAdvance = { playerId, outcome: "sobered-up" };
    } else {
      advanceTurn(match);
    }
    return { ok: true, outcome: "sobered-up" };
  }

  if (action === "straighten") {
    if (!match.bentIds.includes(playerId)) {
      return { ok: false, error: "Your nail does not need straightening." };
    }
    match.bentIds = match.bentIds.filter((id) => id !== playerId);
    if (!match.bonusIds.includes(playerId)) match.bonusIds.push(playerId);
    if (match.suddenDeathActive) match.suddenDeathRound[playerId] = false;
    if (allowNpc) {
      match.lastSwing = null;
      match.pendingAdvance = { playerId, outcome: "straightened" };
    } else {
      advanceTurn(match);
    }
    return { ok: true, outcome: "straightened" };
  }

  if (!["hit", "bullseye", "bent", "miss"].includes(action)) {
    return { ok: false, error: "Invalid hit result." };
  }
  if (match.suddenDeathActive && action === "bullseye") action = "hit";
  const position = swingPosition === null || swingPosition === undefined
    ? Number.NaN
    : Number(swingPosition);
  const bent = match.bentIds.includes(playerId);
  const bonus = match.bonusIds.includes(playerId);
  match.lastSwing = {
    count: ++match.swingCount,
    playerId,
    action,
    position: Number.isFinite(position) ? Math.max(0, Math.min(100, position)) : 50,
    bent,
    bonus,
    drunk: player.drunk,
    stats: swingStats(player, bent, bonus, match.suddenDeathActive)
  };

  if (action === "hit" || action === "bullseye") {
    const result = recordHit(room, match, player, action);
    if (result === "won") return { ok: true, outcome: "won" };
    if (result === "forfeit") return { ok: true, outcome: "forfeit" };
    if (result === "game-won") {
      match.pendingAdvance = { playerId, outcome: "game-won" };
      return { ok: true, outcome: "game-won" };
    }
  } else if (action === "miss") {
    match.bonusIds = match.bonusIds.filter((id) => id !== playerId);
    if (match.suddenDeathActive) match.suddenDeathRound[playerId] = false;
    if (!match.suddenDeathActive) {
      if (allowNpc) return { ok: true, ...recordBeer(player, match, random) };
      match.pendingDrinkPlayerId = playerId;
      return { ok: true, outcome: "miss" };
    }
  } else if (action === "bent") {
    match.bonusIds = match.bonusIds.filter((id) => id !== playerId);
    if (!match.bentIds.includes(playerId)) match.bentIds.push(playerId);
    if (match.suddenDeathActive) match.suddenDeathRound[playerId] = false;
  }

  match.pendingAdvance = { playerId, outcome: action };
  return { ok: true, outcome: action };
}

function recordHit(room, match, player, action) {
  const playerId = player.id;
  if (match.suddenDeathActive) {
    match.scores[playerId] += action === "bullseye" ? 2 : 1;
    match.suddenDeathRound[playerId] = true;
    match.hitEffectCount += 1;
    match.hitEffect = {
      matchId: match.matchId,
      count: match.hitEffectCount,
      kind: action,
      playerId
    };
    match.bonusIds = match.bonusIds.filter((id) => id !== playerId);
    return "sudden-death";
  }
  match.scores[playerId] = Math.min(
    match.hitsToWin,
    match.scores[playerId] + (action === "bullseye" ? 2 : 1)
  );
  match.hitEffectCount += 1;
  match.hitEffect = {
    matchId: match.matchId,
    count: match.hitEffectCount,
    kind: action,
    playerId
  };
  match.bonusIds = match.bonusIds.filter((id) => id !== playerId);
  if (match.scores[playerId] < match.hitsToWin) return "hit";
  const opponentId = match.playerIds.find((id) => id !== playerId);
  if (match.scores[playerId] - match.scores[opponentId] > 2) {
    awardGame(room, match, playerId);
    return room.currentMatch ? "forfeit" : "won";
  }
  if (!match.gamePointId) {
    match.gamePointId = playerId;
    return "game-point";
  }
  if (match.gamePointId !== playerId) {
    match.gamePointId = null;
    match.suddenDeathActive = true;
    match.suddenDeathRound = {};
    match.suddenDeathBeerDrank = {};
    return "game-tied";
  }
  return "game-point";
}

function applyNpcTurn(room, random = Math.random) {
  const match = room.currentMatch;
  if (!match) return { ok: false, error: "There is no active match." };
  const playerId = match.playerIds[match.turnIndex];
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player?.isNpc) return { ok: false, error: "It is not an NPC turn." };
  if (match.pendingAdvance) return { ok: false, error: "Confirm the previous turn first." };

  const bent = match.bentIds.includes(playerId);
  const opponentId = match.playerIds.find((id) => id !== playerId);
  const mustCatchUp = match.gamePointId === opponentId && match.scores[opponentId] >= match.hitsToWin;
  const canStraighten = bent && !mustCatchUp;
  const drankBeforeSwing = Boolean(match.suddenDeathBeerDrank[playerId]);
  const choice = drankBeforeSwing
    ? 0
    : player.drunk > 0 || canStraighten ? random() : 1;
  if (!drankBeforeSwing && player.drunk > 0 && !match.suddenDeathActive) {
    if (bent && !mustCatchUp) {
      if (choice >= 0.4 && choice < 0.9) {
        return applyNpcTurnAction(room, playerId, "straighten");
      }
      if (choice >= 0.9) return applyNpcTurnAction(room, playerId, "sober-up");
    } else if (choice < 0.1) {
      return applyNpcTurnAction(room, playerId, "sober-up");
    }
  } else if (canStraighten && choice < 0.5) {
    return applyNpcTurnAction(room, playerId, "straighten");
  }

  if (match.suddenDeathActive && !match.suddenDeathBeerDrank[playerId]) {
    recordBeer(player, match, random, false);
    return { ok: true, outcome: "drink-before-swing" };
  }

  const hitChance = npcHitChance(player);
  const bentChance = (1 - hitChance) / 2;
  const roll = random();
  const bonus = match.bonusIds.includes(playerId);
  const swingSnapshot = {
    bent,
    bonus,
    drunk: player.drunk,
    stats: swingStats(player, bent, bonus, match.suddenDeathActive)
  };
  let outcome;
  let position;
  if (roll < hitChance) {
    const hitFraction = roll / hitChance;
    const criticalChance = Math.min(1, swingSnapshot.stats.criticalWidth / swingSnapshot.stats.width);
    const isCritical = criticalChance > 0 && hitFraction < criticalChance;
    if (isCritical) {
      position = 50 + ((hitFraction / criticalChance) * 2 - 1) * swingSnapshot.stats.criticalWidth / 2;
    } else {
      const regularHitFraction = criticalChance === 1
        ? 0
        : (hitFraction - criticalChance) / (1 - criticalChance);
      position = npcSwingPosition("hit", swingSnapshot.stats, regularHitFraction);
    }
    const action = isCritical ? "bullseye" : "hit";
    match.lastSwing = { count: ++match.swingCount, playerId, action, position, ...swingSnapshot };
    outcome = recordHit(room, match, player, action);
    if (outcome === "won") return { ok: true, outcome };
    if (outcome === "forfeit") return { ok: true, outcome };
  } else if (roll < hitChance + bentChance) {
    position = npcSwingPosition("bent", swingSnapshot.stats, (roll - hitChance) / bentChance);
    match.lastSwing = { count: ++match.swingCount, playerId, action: "bent", position, ...swingSnapshot };
    match.bonusIds = match.bonusIds.filter((id) => id !== playerId);
    if (!match.bentIds.includes(playerId)) match.bentIds.push(playerId);
    if (match.suddenDeathActive) match.suddenDeathRound[playerId] = false;
    outcome = "bent";
  } else {
    position = npcSwingPosition("miss", swingSnapshot.stats, (roll - hitChance - bentChance) / (1 - hitChance - bentChance));
    match.lastSwing = { count: ++match.swingCount, playerId, action: "miss", position, ...swingSnapshot };
    match.bonusIds = match.bonusIds.filter((id) => id !== playerId);
    if (match.suddenDeathActive) match.suddenDeathRound[playerId] = false;
    if (!match.suddenDeathActive) recordBeer(player, match, random);
    outcome = "miss";
  }

  if (room.currentMatch) match.pendingAdvance = { playerId, outcome };
  return { ok: true, outcome };
}

function applyNpcTurnAction(room, playerId, action) {
  const match = room.currentMatch;
  if (!match) return { ok: false, error: "There is no active match." };
  return applyTurnAction(room, playerId, action, Math.random, null, true);
}

function npcSwingPosition(outcome, stats, fraction) {
  const boundedFraction = Math.max(0, Math.min(0.999999, fraction));
  const hitHalfWidth = stats.width / 2;
  const criticalHalfWidth = stats.criticalWidth / 2;
  if (outcome === "hit") {
    const nonCriticalHalfWidth = Math.max(0, hitHalfWidth - criticalHalfWidth);
    const edgeMargin = Math.min(0.01, nonCriticalHalfWidth / 2);
    const usableHalfWidth = Math.max(0, nonCriticalHalfWidth - edgeMargin);
    const halfFraction = (boundedFraction % 0.5) * 2;
    return boundedFraction < 0.5
      ? 50 - hitHalfWidth + halfFraction * usableHalfWidth
      : 50 + criticalHalfWidth + edgeMargin + halfFraction * usableHalfWidth;
  }

  const bendHalfWidth = stats.bendWidth;
  const bendStart = hitHalfWidth;
  if (outcome === "bent") {
    const offset = boundedFraction * bendHalfWidth * 2;
    return offset < bendHalfWidth
      ? 50 - bendStart - bendHalfWidth + offset
      : 50 + bendStart + (offset - bendHalfWidth);
  }

  const missStart = hitHalfWidth + bendHalfWidth;
  const missSpan = Math.max(0, 50 - missStart);
  const offset = boundedFraction * missSpan * 2;
  return offset < missSpan
    ? offset
    : 100 - missSpan + (offset - missSpan);
}

function swingStats(player, isBent = false, hasBonus = false, isSuddenDeath = false) {
  const strength = isBent ? 0 : hasBonus ? MAX_STAT : player.strength;
  const baseWidth = Math.max(5, 16 + strength * 2.8 - player.drunk * 1.5);
  const width = Math.min(100, baseWidth * (isBent ? 0.5 : 1));
  const dexterityFactor = 0.7 + player.dexterity * 0.15;
  const speedAtZeroDexterity = 105 / (0.7 + 3 * 0.15) * 2.5;
  const missWidth = 100 - width;
  const bendShare = 0.3 + 0.45 * player.dexterity / MAX_STAT;
  return {
    width,
    criticalWidth: isSuddenDeath ? 0 : isBent ? 2 : Math.min(7, 2 + player.strength * 0.25),
    bendWidth: missWidth * bendShare / 2,
    wisdomSlowdown: player.wisdom * 0.12,
    speed: Math.min(450, speedAtZeroDexterity * 0.7 / dexterityFactor)
  };
}

function confirmTurn(room, playerId, isHost = false) {
  const match = room.currentMatch;
  const pending = match?.pendingAdvance;
  if (!pending) return { ok: false, error: "There is no turn waiting for confirmation." };
  if (!isHost && pending.playerId !== playerId) {
    return { ok: false, error: "Only the player who took the turn or the host can confirm it." };
  }
  match.pendingAdvance = null;
  match.pendingDrinkPlayerId = null;
  match.lastDrink = null;
  advanceTurn(match);
  if (match.gamePointId && pending.playerId !== match.gamePointId) {
    const winnerId = match.gamePointId;
    match.gamePointId = null;
    awardGame(room, match, winnerId);
  } else if (match.suddenDeathActive &&
      match.playerIds.every((id) => Object.hasOwn(match.suddenDeathRound, id))) {
    const [firstId, secondId] = match.playerIds;
    const firstHit = match.suddenDeathRound[firstId];
    const secondHit = match.suddenDeathRound[secondId];
    if (firstHit !== secondHit) {
      awardGame(room, match, firstHit ? firstId : secondId);
    } else {
      match.suddenDeathRound = {};
      match.suddenDeathBeerDrank = {};
      for (const id of match.playerIds) {
        const participant = room.players.find((entry) => entry.id === id);
        if (participant?.drunk >= MAX_INTOXICATION) lowerHighestSuddenDeathStat(match, participant);
      }
    }
  }
  return { ok: true };
}

function setPlayerStats(player, stats) {
  for (const stat of ["strength", "dexterity", "constitution", "wisdom"]) {
    if (stats?.[stat] === undefined && stat === "wisdom") continue;
    const value = Number(stats?.[stat]);
    if (Number.isInteger(value) && value >= MIN_STAT && value <= MAX_STAT) {
      player[stat] = value;
    }
  }
}

function npcHitChance(player) {
  return 0.2 + ((player.strength + player.dexterity + player.wisdom) / 15) * 0.75;
}

function randomizeBracket(room, random = Math.random) {
  if (room.phase !== "lobby" || room.players.length < 2) return false;
  for (let index = room.players.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [room.players[index], room.players[target]] = [room.players[target], room.players[index]];
  }
  return true;
}

function restartCurrentMatch(room) {
  if (!room.currentMatch || room.phase !== "tournament") return false;
  const match = room.currentMatch;
  restoreMatchStats(room, match);
  room.currentMatch = createMatch(match.round, [...match.playerIds], match.roundIndex, {
    hitsToWin: match.hitsToWin,
    bestOf: match.bestOf,
    skipNpcOnly: match.skipNpcOnly
  });
  match.playerIds.forEach((id) => {
    const player = room.players.find((entry) => entry.id === id);
    player.beersDrank = 0;
    player.drunk = 0;
    room.currentMatch.originalStats[id] = Object.fromEntries(
      ["strength", "dexterity", "wisdom"].map((stat) => [stat, player[stat]])
    );
    room.currentMatch.statPenalties[id] = { strength: 0, dexterity: 0, wisdom: 0 };
  });
  return true;
}

function publicState(room) {
  const visibleMatch = room.currentMatch ? { ...room.currentMatch } : null;
  if (visibleMatch) delete visibleMatch.originalStats;
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map((player, seed) => {
      const { reconnectTokenHash, socketId, ...publicPlayer } = player;
      return { ...publicPlayer, seed: seed + 1 };
    }),
    lastMatchStump: room.lastMatchStump ? {
      ...room.lastMatchStump,
      playerIds: [...room.lastMatchStump.playerIds],
      scores: { ...room.lastMatchStump.scores },
      gameWins: { ...room.lastMatchStump.gameWins },
      bentIds: [...room.lastMatchStump.bentIds],
      beers: { ...room.lastMatchStump.beers }
    } : null,
    currentMatch: room.currentMatch
      ? {
          ...visibleMatch,
          playerIds: [...room.currentMatch.playerIds],
          scores: { ...room.currentMatch.scores },
          suddenDeathWinners: [...room.currentMatch.suddenDeathWinners],
          bentIds: [...room.currentMatch.bentIds],
          bonusIds: [...room.currentMatch.bonusIds],
          hitEffect: room.currentMatch.hitEffect ? { ...room.currentMatch.hitEffect } : null,
          pendingAdvance: room.currentMatch.pendingAdvance ? { ...room.currentMatch.pendingAdvance } : null,
          suddenDeathBeerDrank: { ...room.currentMatch.suddenDeathBeerDrank },
          statPenalties: Object.fromEntries(
            Object.entries(room.currentMatch.statPenalties).map(([id, stats]) => [id, { ...stats }])
          ),
          lastSwing: room.currentMatch.lastSwing ? { ...room.currentMatch.lastSwing } : null,
          lastDrink: room.currentMatch.lastDrink ? { ...room.currentMatch.lastDrink } : null
        }
      : null,
    pendingMatches: room.pendingMatches.map((match) => ({
      round: match.round,
      roundIndex: match.roundIndex,
      playerIds: [...match.playerIds],
      gameWins: { ...match.gameWins },
      lane: match.lane,
      hitsToWin: match.hitsToWin,
      bestOf: match.bestOf
    })),
    history: room.history.map((match) => ({
      ...match,
      playerIds: [...match.playerIds],
      suddenDeathWinners: [...match.suddenDeathWinners],
      hitEffect: match.hitEffect ? { ...match.hitEffect } : null,
      lastSwing: match.lastSwing ? { ...match.lastSwing } : null
    })),
    seedIds: [...room.seedIds],
    championId: room.championId,
    npcMatchMode: room.npcMatchMode,
    defaultMatchSettings: { ...room.defaultMatchSettings },
    nextMatchSettings: { ...room.nextMatchSettings },
    npcManualTurnId: room.npcManualTurnId,
    npcStepRequired: room.npcStepRequired,
    npcStepInProgress: room.npcStepInProgress,
    roundNumber: room.roundNumber,
    roundLabel: room.roundLabel,
    roundByes: [...room.roundByes]
  };
}

module.exports = {
  MAX_PLAYERS,
  MAX_HITS_TO_WIN,
  npcHitChance,
  MAX_STAT,
  MAX_INTOXICATION,
  MIN_STAT,
  applyAction,
  applyHostNpcAction,
  applyNpcTurn,
  awardMatchToWinner,
  confirmTurn,
  createPlayer,
  createRoom,
  makeRoomCode,
  publicState,
  randomizeBracket,
  restartCurrentMatch,
  resolveCurrentMatch,
  prepareNextMatch,
  setPlayerStats,
  setMatchBestOf,
  setMatchHitsToWin,
  seedTournament,
  startNextMatch,
  swingStats
};
