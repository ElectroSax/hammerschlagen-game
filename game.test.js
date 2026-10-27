const test = require("node:test");
const assert = require("node:assert/strict");
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
  confirmTurn,
  createPlayer,
  createRoom,
  publicState,
  restartCurrentMatch,
  randomizeBracket,
  setPlayerStats,
  setMatchBestOf,
  setMatchHitsToWin,
  seedTournament,
  startNextMatch,
  swingStats,
  npcHitChance,
  resolveCurrentMatch
} = require("./game");

function roomWithPlayers(count) {
  const room = createRoom("TEST", "host");
  room.players = Array.from({ length: count }, (_, index) => createPlayer(`p${index + 1}`, `Player ${index + 1}`));
  seedTournament(room);
  return room;
}

function winCurrentGame(room, playerId = room.currentMatch.playerIds[0]) {
  const match = room.currentMatch;
  const opponentId = match.playerIds.find((id) => id !== playerId);
  match.turnIndex = match.playerIds.indexOf(playerId);
  match.scores[playerId] = match.hitsToWin - 1;
  const result = applyAction(room, playerId, "hit");
  if (!result.ok) return result;
  confirmTurn(room, playerId);
  if (room.currentMatch !== match) return result;
  assert.equal(match.playerIds[match.turnIndex], opponentId);
  assert.equal(applyAction(room, opponentId, "miss").ok, true);
  assert.equal(applyAction(room, opponentId, "drink", () => 0.999).ok, true);
  confirmTurn(room, opponentId);
  return result;
}

function winCurrentMatch(room, playerId = room.currentMatch.playerIds[0]) {
  let result;
  while (room.currentMatch) {
    const winner = playerId;
    result = winCurrentGame(room, winner);
    if (!room.currentMatch) break;
    if (room.currentMatch.gameWins[winner] >= Math.ceil(room.currentMatch.bestOf / 2)) break;
  }
  return result;
}

test("32 participants are capped and seeds play through to a champion", () => {
  assert.equal(MAX_PLAYERS, 32);
  const room = roomWithPlayers(32);
  assert.equal(startNextMatch(room), true);
  assert.equal(room.currentMatch.round, "Winners Round 1");
  assert.equal(room.currentMatch.roundIndex, 1);
  assert.equal(publicState(room).seedIds.length, 32);
  assert.deepEqual(room.currentMatch.playerIds, ["p1", "p2"]);

  while (room.phase === "tournament") {
    if (!room.currentMatch && !startNextMatch(room)) break;
    assert.equal(winCurrentMatch(room).ok, true);
  }

  assert.equal(room.phase, "complete");
  assert.equal(room.history.length, 62);
  assert.equal(room.championId, "p1");
  assert.equal(room.history[0].lane, "winners");
  assert.equal(room.history.at(-1).lane, "finals");
});

test("beer checks cap intoxication at six", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  room.players[0].drunk = MAX_INTOXICATION;
  applyAction(room, "p1", "miss");
  const result = applyAction(room, "p1", "drink", () => 0);
  assert.equal(result.drink.penalty, true);
  assert.equal(room.players[0].drunk, MAX_INTOXICATION);
  room.players[0].beersDrank = 20;
  room.currentMatch.pendingAdvance = null;
  room.currentMatch.pendingDrinkPlayerId = "p1";
  assert.equal(applyAction(room, "p1", "drink", () => 0).drink.threshold, 25);
});

test("sober-up uses a turn and reduces intoxication by one", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  room.players[0].drunk = 3;

  assert.equal(applyAction(room, "p1", "sober-up").outcome, "sobered-up");
  assert.equal(room.players[0].drunk, 2);
  assert.equal(room.currentMatch.turnIndex, 1);
  assert.equal(applyAction(room, "p1", "sober-up").ok, false);

  room.players[1].isNpc = true;
  room.players[1].drunk = 2;
  const npcResult = applyNpcTurn(room, () => 0.05);
  assert.equal(npcResult.outcome, "sobered-up");
  assert.equal(room.players[1].drunk, 1);
  assert.equal(room.currentMatch.pendingAdvance.outcome, "sobered-up");
  assert.equal(confirmTurn(room, null, true).ok, true);
  assert.equal(room.currentMatch.turnIndex, 0);
});

test("an intoxicated bent NPC chooses hit, straighten, or sober-up at the configured proportions", () => {
  const room = createRoom("NPCCHOICES", "host");
  room.players = [createPlayer("npc", "NPC", true), createPlayer("player", "Player")];
  seedTournament(room);
  startNextMatch(room);
  const match = room.currentMatch;
  const npc = room.players[0];
  npc.drunk = 1;
  match.bentIds = ["npc"];

  const hitRolls = [0.2, 0.2];
  assert.equal(applyNpcTurn(room, () => hitRolls.shift()).outcome, "hit");
  assert.equal(match.scores.npc, 1);

  match.pendingAdvance = null;
  match.turnIndex = 0;
  match.bentIds = ["npc"];
  assert.equal(applyNpcTurn(room, () => 0.5).outcome, "straightened");

  match.pendingAdvance = null;
  match.turnIndex = 0;
  match.bentIds = ["npc"];
  assert.equal(applyNpcTurn(room, () => 0.95).outcome, "sobered-up");
  assert.equal(npc.drunk, 0);
});

test("odd fields get byes and still produce one champion", () => {
  const room = roomWithPlayers(5);
  startNextMatch(room);
  assert.deepEqual(room.roundByes, ["p5"]);
  while (room.phase === "tournament") {
    if (!room.currentMatch && !startNextMatch(room)) break;
    winCurrentMatch(room);
  }
  assert.equal(room.phase, "complete");
  assert.ok(room.championId);
});

test("bent nails and full-miss beer checks wait for explicit turn confirmation", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  assert.equal(applyAction(room, "p1", "bent", Math.random, 28).outcome, "bent");
  assert.equal(room.currentMatch.turnIndex, 0);
  assert.equal(room.currentMatch.lastSwing.position, 28);
  assert.equal(confirmTurn(room, "p2").ok, false);
  assert.equal(applyAction(room, "p1", "hit").ok, false);
  assert.equal(confirmTurn(room, "p1").ok, true);
  assert.equal(room.currentMatch.turnIndex, 1);
  assert.deepEqual(room.currentMatch.bentIds, ["p1"]);
  assert.equal(applyAction(room, "p2", "miss").outcome, "miss");
  assert.equal(applyAction(room, "p2", "hit").ok, false);
  const drink = applyAction(room, "p2", "drink", () => 0);
  assert.equal(drink.outcome, "drink");
  assert.equal(drink.drink.roll, 1);
  assert.equal(room.currentMatch.turnIndex, 1);
  assert.equal(room.currentMatch.pendingAdvance.playerId, "p2");
  assert.equal(confirmTurn(room, "p2").ok, true);
  assert.equal(room.currentMatch.lastDrink, null);
  assert.equal(applyAction(room, "p1", "straighten").outcome, "straightened");
  assert.deepEqual(room.currentMatch.bentIds, []);
  assert.deepEqual(room.currentMatch.bonusIds, ["p1"]);
  const boosted = swingStats(room.players[0], false, true);
  assert.equal(boosted.width, 30);
  room.currentMatch.turnIndex = room.currentMatch.playerIds.indexOf("p1");
  room.currentMatch.bentIds = ["p1"];
  assert.equal(applyAction(room, "p1", "hit").ok, true);
  assert.deepEqual(room.currentMatch.bentIds, ["p1"]);
  assert.equal(room.currentMatch.turnIndex, 0);
  assert.equal(confirmTurn(room, "p1").ok, true);
  assert.deepEqual(room.currentMatch.bonusIds, []);
});

test("a game point gives the opponent one last turn, then tied targets enter sudden death", () => {
  const room = roomWithPlayers(2);
  room.defaultMatchSettings = { hitsToWin: 1, bestOf: 1, skipNpcOnly: false };
  seedTournament(room);
  startNextMatch(room);

  assert.equal(applyAction(room, "p1", "hit").outcome, "hit");
  assert.equal(room.currentMatch.gamePointId, "p1");
  assert.equal(confirmTurn(room, "p1").ok, true);
  assert.equal(room.currentMatch.playerIds[room.currentMatch.turnIndex], "p2");
  assert.equal(applyAction(room, "p2", "hit").outcome, "hit");
  assert.equal(room.currentMatch.gamePointId, null);
  assert.equal(room.currentMatch.suddenDeathActive, true);
  confirmTurn(room, "p2");

  assert.equal(applyAction(room, "p1", "hit").ok, false);
  const firstSuddenDeathDrink = applyAction(room, "p1", "drink", () => 0.999);
  assert.equal(firstSuddenDeathDrink.outcome, "drink-before-swing");
  assert.equal(room.currentMatch.pendingAdvance, null);
  assert.equal(room.currentMatch.suddenDeathBeerDrank.p1, true);
  const suddenDeathHit = applyAction(room, "p1", "bullseye");
  assert.equal(suddenDeathHit.ok, true);
  assert.equal(room.currentMatch.lastSwing.action, "hit");
  assert.equal(room.currentMatch.lastSwing.stats.criticalWidth, 0);
  assert.equal(room.currentMatch.scores.p1, 2);
  confirmTurn(room, "p1");
  assert.equal(room.currentMatch.suddenDeathBeerDrank.p1, true);
  assert.equal(applyAction(room, "p2", "miss").ok, false);
  applyAction(room, "p2", "drink", () => 0.999);
  assert.equal(applyAction(room, "p2", "miss").ok, true);
  confirmTurn(room, "p2");
  assert.equal(room.phase, "tournament");
  assert.equal(room.history[0].winnerId, "p1");
  assert.equal(room.history[0].scores.p1, 1);
  assert.deepEqual(room.history[0].suddenDeathWinners, ["p1"]);
});

test("a player or NPC forfeits the game when they are more than two hits behind", () => {
  const humanRoom = roomWithPlayers(2);
  startNextMatch(humanRoom);
  humanRoom.currentMatch.scores.p1 = 2;
  assert.equal(applyAction(humanRoom, "p1", "hit").outcome, "won");
  assert.equal(humanRoom.currentMatch, null);
  assert.equal(humanRoom.history[0].winnerId, "p1");
  assert.deepEqual(humanRoom.history[0].finalScores, { p1: 3, p2: 0 });

  const npcRoom = roomWithPlayers(2);
  npcRoom.players[0].isNpc = true;
  startNextMatch(npcRoom);
  npcRoom.currentMatch.scores.p1 = 2;
  assert.equal(applyNpcTurn(npcRoom, () => 0).outcome, "won");
  assert.equal(npcRoom.currentMatch, null);
  assert.equal(npcRoom.history[0].winnerId, "p1");
});

test("normal hits cap at three while sudden-death hits can increase the score", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  room.currentMatch.scores.p1 = 2;
  room.currentMatch.scores.p2 = 1;
  assert.equal(applyAction(room, "p1", "bullseye").ok, true);
  assert.equal(room.currentMatch.scores.p1, 3);
  assert.equal(room.currentMatch.gamePointId, "p1");

  room.currentMatch.scores.p2 = 3;
  room.currentMatch.gamePointId = null;
  room.currentMatch.suddenDeathActive = true;
  room.currentMatch.suddenDeathRound = {};
  room.currentMatch.suddenDeathBeerDrank = { p1: true };
  room.currentMatch.pendingAdvance = null;
  room.currentMatch.turnIndex = 0;
  assert.equal(applyAction(room, "p1", "hit").ok, true);
  assert.equal(room.currentMatch.scores.p1, 4);
});

test("NPC hit chance scales from 20% to 95% with all three combat stats", () => {
  const player = createPlayer("npc", "NPC", true);
  player.strength = 0;
  player.dexterity = 0;
  player.wisdom = 0;
  assert.equal(npcHitChance(player), 0.2);
  player.strength = 5;
  player.dexterity = 5;
  player.wisdom = 5;
  assert.equal(npcHitChance(player), 0.95);
  player.strength = 2;
  player.dexterity = 3;
  player.wisdom = 4;
  assert.ok(Math.abs(npcHitChance(player) - 0.65) < Number.EPSILON);
});

test("host can preselect a participant to win a queued match", () => {
  const room = roomWithPlayers(4);
  startNextMatch(room);
  assert.equal(resolveCurrentMatch(room, "p2"), true);
  assert.equal(room.currentMatch, null);
  assert.equal(room.history[0].winnerId, "p2");
  assert.equal(room.history[0].gameWins.p2, 0);
  assert.equal(room.pendingMatches[0].playerIds[0], "p3");
  assert.equal(resolveCurrentMatch(room, "p4"), false);
});

test("NPCs automatically drink before each sudden-death swing", () => {
  const room = createRoom("SDNPC", "host");
  room.players = [createPlayer("npc", "NPC", true), createPlayer("player", "Player")];
  room.players[0].strength = 5;
  room.players[0].dexterity = 5;
  seedTournament(room);
  startNextMatch(room);
  const match = room.currentMatch;
  match.suddenDeathActive = true;
  match.suddenDeathBeerDrank = {};
  match.turnIndex = 0;

  const rolls = [0, 0.5];
  assert.equal(applyNpcTurn(room, () => rolls.shift()).outcome, "drink-before-swing");
  assert.equal(room.players[0].beersDrank, 1);
  assert.equal(match.suddenDeathBeerDrank.npc, true);
  assert.equal(match.lastDrink.playerId, "npc");
  assert.equal(match.scores.npc, 0);
  assert.equal(applyNpcTurn(room, () => rolls.shift()).outcome, "sudden-death");
  assert.equal(match.scores.npc, 1);
  assert.equal(match.pendingAdvance.playerId, "npc");
});

test("a bent nail retains a narrow two-hit bullseye", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  const match = room.currentMatch;
  match.bentIds = ["p1"];
  assert.equal(swingStats(room.players[0], true).criticalWidth, 2);
  assert.equal(applyAction(room, "p1", "bullseye").ok, true);
  assert.equal(match.scores.p1, 2);
  assert.deepEqual(match.bentIds, ["p1"]);
  assert.equal(match.lastSwing.stats.criticalWidth, 2);
});

test("a host-controlled NPC must drink before swinging in sudden death", () => {
  const room = createRoom("MANUALSD", "host");
  room.players = [createPlayer("npc", "NPC", true), createPlayer("player", "Player")];
  seedTournament(room);
  startNextMatch(room);
  const match = room.currentMatch;
  match.suddenDeathActive = true;

  assert.equal(applyHostNpcAction(room, "npc", "hit", 50).ok, false);
  assert.equal(applyHostNpcAction(room, "npc", "drink").outcome, "drink-before-swing");
  assert.equal(match.pendingAdvance, null);
  assert.equal(applyHostNpcAction(room, "npc", "hit", 50).outcome, "hit");
  assert.equal(match.scores.npc, 1);
});

test("a bent NPC never straightens on its final catch-up turn against three hits", () => {
  const room = createRoom("CATCHUP", "host");
  room.players = [createPlayer("player", "Player"), createPlayer("npc", "NPC", true)];
  seedTournament(room);
  startNextMatch(room);
  const match = room.currentMatch;
  match.hitsToWin = 3;
  match.scores.player = 3;
  match.gamePointId = "player";
  match.bentIds = ["npc"];
  match.turnIndex = 1;

  const rolls = [0.1, 0.9];
  const result = applyNpcTurn(room, () => rolls.shift());
  assert.notEqual(result.outcome, "straightened");
  assert.deepEqual(match.bentIds, ["npc"]);
  assert.ok(match.lastSwing);
});

test("the completed match stump stays visible until the host starts the next match", () => {
  const room = roomWithPlayers(4);
  startNextMatch(room);
  room.currentMatch.scores.p1 = 2;
  room.currentMatch.bentIds = ["p2"];
  room.players[0].beersDrank = 2;
  winCurrentMatch(room);

  const saved = publicState(room).lastMatchStump;
  assert.deepEqual(saved.playerIds, ["p1", "p2"]);
  assert.equal(saved.scores.p1, 3);
  assert.deepEqual(saved.bentIds, ["p2"]);
  assert.equal(saved.beers.p1, 2);
  assert.equal(room.currentMatch, null);

  startNextMatch(room);
  assert.equal(publicState(room).lastMatchStump, null);
});

test("the lower-bracket champion can force and win a grand-final reset", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  winCurrentMatch(room, "p1");
  assert.equal(startNextMatch(room), true);
  assert.equal(room.currentMatch.lane, "finals");
  assert.equal(room.currentMatch.round, "Grand Final");
  winCurrentMatch(room, "p2");
  assert.equal(room.phase, "tournament");
  assert.equal(room.grandFinalReset, true);
  assert.equal(startNextMatch(room), true);
  assert.equal(room.currentMatch.round, "Grand Final Reset");
  winCurrentMatch(room, "p2");
  assert.equal(room.phase, "complete");
  assert.equal(room.championId, "p2");
  assert.equal(room.players.find((player) => player.id === "p1").losses, 2);
});

test("constitution modifies the beer check and failed checks stack drunkenness", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  room.players[0].constitution = 3;
  assert.equal(applyAction(room, "p1", "miss").ok, true);
  const failed = applyAction(room, "p1", "drink", () => 0);
  assert.equal(failed.drink.threshold, 13);
  assert.equal(failed.drink.roll + 3 <= 13, true);
  assert.equal(failed.drink.penalty, true);
  assert.equal(room.players[0].drunk, 1);
  assert.equal(room.currentMatch.lastSwing.drunk, 0);
  assert.equal(room.currentMatch.lastSwing.stats.width, swingStats(room.players[0], false).width + 1.5);
  assert.equal(confirmTurn(room, "p1").ok, true);

  room.currentMatch.turnIndex = room.currentMatch.playerIds.indexOf("p1");
  assert.equal(applyAction(room, "p1", "miss").ok, true);
  const saved = applyAction(room, "p1", "drink", () => 0.95);
  assert.equal(saved.drink.roll, 20);
  assert.equal(saved.drink.threshold, 16);
  assert.equal(saved.drink.penalty, false);
  assert.equal(room.players[0].drunk, 1);
  assert.equal(confirmTurn(room, "p1").ok, true);

  room.currentMatch.turnIndex = room.currentMatch.playerIds.indexOf("p1");
  assert.equal(applyAction(room, "p1", "miss").ok, true);
  const failedAgain = applyAction(room, "p1", "drink", () => 0);
  assert.equal(failedAgain.drink.threshold, 19);
  assert.equal(failedAgain.drink.penalty, true);
  assert.equal(room.players[0].drunk, 2);
});

test("NPC turns advance only after one confirmation and full misses auto-roll a beer", () => {
  const room = createRoom("NPC", "host");
  room.players = [
    createPlayer("human", "Human"),
    createPlayer("npc", "NPC", true)
  ];
  room.players[1].strength = 1;
  room.players[1].dexterity = 0;
  room.players[1].wisdom = 0;
  seedTournament(room);
  startNextMatch(room);
  room.currentMatch.turnIndex = 1;

  assert.equal(applyNpcTurn(room, () => 0.15).outcome, "hit");
  const npcHit = room.currentMatch.lastSwing;
  assert.ok(Math.abs(npcHit.position - 50) <= npcHit.stats.width / 2);
  assert.ok(Math.abs(npcHit.position - 50) > npcHit.stats.criticalWidth / 2);
  assert.equal(room.currentMatch.turnIndex, 1);
  assert.equal(applyNpcTurn(room, () => 0.05).ok, false);
  assert.equal(confirmTurn(room, "human").ok, false);
  assert.equal(confirmTurn(room, null, true).ok, true);
  assert.equal(room.currentMatch.turnIndex, 0);
  room.currentMatch.turnIndex = 1;
  assert.equal(applyNpcTurn(room, () => 0.3).outcome, "bent");
  const npcBent = room.currentMatch.lastSwing;
  assert.ok(Math.abs(npcBent.position - 50) > npcBent.stats.width / 2);
  assert.ok(Math.abs(npcBent.position - 50) <= npcBent.stats.width / 2 + npcBent.stats.bendWidth);
  assert.equal(confirmTurn(room, null, true).ok, true);
  room.currentMatch.turnIndex = 1;
  const rolls = [0.8, 0.99, 0];
  assert.equal(applyNpcTurn(room, () => rolls.shift()).outcome, "miss");
  assert.equal(room.players[1].beersDrank, 1);
  assert.equal(room.currentMatch.pendingDrinkPlayerId, null);
  assert.equal(room.currentMatch.pendingAdvance.playerId, "npc");
  assert.equal(room.players[1].drunk, 1);
  assert.equal(room.currentMatch.lastSwing.drunk, 0);
  assert.equal(room.currentMatch.lastSwing.stats.speed, swingStats({ ...room.players[1], drunk: 0 }).speed);
  assert.ok(Math.abs(room.currentMatch.lastSwing.position - 50) >
    room.currentMatch.lastSwing.stats.width / 2 + room.currentMatch.lastSwing.stats.bendWidth);
  assert.equal(confirmTurn(room, null, true).ok, true);
  assert.equal(room.currentMatch.lastDrink, null);

  room.players[1].strength = 5;
  room.players[1].dexterity = 5;
  room.players[1].wisdom = 5;
  room.currentMatch.turnIndex = 1;
  const finalRolls = [0.2, 0.9];
  assert.equal(applyNpcTurn(room, () => finalRolls.shift()).outcome, "hit");
  assert.equal(confirmTurn(room, null, true).ok, true);
});

test("NPCs can occasionally land a critical hit and score two hits", () => {
  const room = createRoom("NPC CRIT", "host");
  room.players = [
    createPlayer("human", "Human"),
    createPlayer("npc", "NPC", true)
  ];
  room.players[1].strength = 5;
  room.players[1].dexterity = 5;
  room.players[1].wisdom = 5;
  seedTournament(room);
  startNextMatch(room);
  room.currentMatch.turnIndex = room.currentMatch.playerIds.indexOf("npc");

  const result = applyNpcTurn(room, () => 0.05);

  assert.equal(result.outcome, "hit");
  assert.equal(room.currentMatch.lastSwing.action, "bullseye");
  assert.ok(Math.abs(room.currentMatch.lastSwing.position - 50) <= room.currentMatch.lastSwing.stats.criticalWidth / 2);
  assert.equal(room.currentMatch.scores.npc, 2);
  assert.equal(room.currentMatch.hitEffect.kind, "bullseye");
});

test("human and NPC turns alternate exactly once across confirmations", () => {
  const room = createRoom("ORDER", "host");
  room.players = [
    createPlayer("human", "Human"),
    createPlayer("npc", "NPC", true)
  ];
  room.players[1].strength = 5;
  room.players[1].dexterity = 5;
  seedTournament(room);
  startNextMatch(room);

  assert.equal(applyAction(room, "human", "hit").ok, true);
  assert.equal(room.currentMatch.turnIndex, 0);
  assert.equal(confirmTurn(room, "human").ok, true);
  assert.equal(room.currentMatch.turnIndex, 1);
  assert.equal(applyNpcTurn(room, () => 0).outcome, "hit");
  assert.equal(room.currentMatch.turnIndex, 1);
  assert.equal(confirmTurn(room, null, true).ok, true);
  assert.equal(room.currentMatch.turnIndex, 0);
});

test("stats from zero to five widen the target, slow the meter, and govern NPC accuracy", () => {
  assert.equal(MIN_STAT, 0);
  assert.equal(MAX_STAT, 5);
  const base = createPlayer("p", "Player");
  const low = swingStats({ ...base, strength: 0, dexterity: 0 });
  const high = swingStats({ ...base, strength: 5, dexterity: 5 });
  assert.ok(high.width > low.width);
  assert.equal(high.width, 30);
  assert.equal(high.criticalWidth, 3.25);
  assert.equal(low.criticalWidth, 2);
  assert.equal(swingStats({ ...base, strength: 5 }, true).criticalWidth, 2);
  assert.ok(high.speed < low.speed);
  const oldSpeedAtDexterityThree = 105 / (0.7 + 3 * 0.15) * 2.5;
  assert.equal(swingStats({ ...base, dexterity: 0 }).speed, oldSpeedAtDexterityThree);
  assert.equal(swingStats(base).speed, oldSpeedAtDexterityThree * 0.7 / 1.15);
  assert.equal(high.bendWidth * 2, (100 - high.width) * 0.75);
  const noDexterity = swingStats({ ...base, dexterity: 0 });
  assert.equal(noDexterity.bendWidth * 2, (100 - noDexterity.width) * 0.3);
  assert.equal(noDexterity.wisdomSlowdown, 0.36);
  assert.equal(MAX_INTOXICATION, 6);
  assert.equal(swingStats(base, false, false, true).criticalWidth, 0);
  assert.equal(swingStats({ ...base, wisdom: 0 }).wisdomSlowdown, 0);
  assert.equal(swingStats({ ...base, wisdom: 5 }).wisdomSlowdown, 0.6);
  assert.equal(
    swingStats({ ...base, wisdom: 5 }).speed,
    swingStats({ ...base, wisdom: 0 }).speed
  );
  const drunk = swingStats({ ...base, drunk: 1 });
  assert.ok(drunk.width < swingStats(base).width);
  assert.equal(swingStats({ ...base, drunk: 5 }).width, swingStats(base).width - 7.5);
  assert.equal(drunk.speed, swingStats(base).speed);
  assert.equal(
    swingStats({ ...base, drunk: 2 }, false, true).width,
    30 - 3
  );
});

test("the host can change the active match hit target and assign a final turn when reached", () => {
  assert.equal(MAX_HITS_TO_WIN, 10);
  const room = roomWithPlayers(2);
  startNextMatch(room);
  assert.equal(room.currentMatch.hitsToWin, 3);
  room.currentMatch.scores.p1 = 1;
  assert.equal(setMatchHitsToWin(room, 1).ok, true);
  assert.equal(room.currentMatch.hitsToWin, 1);
  assert.equal(room.currentMatch.gamePointId, "p1");
  assert.equal(room.currentMatch.playerIds[room.currentMatch.turnIndex], "p2");
  assert.equal(setMatchHitsToWin(room, 11).ok, false);

  const highScoreRoom = roomWithPlayers(2);
  startNextMatch(highScoreRoom);
  highScoreRoom.currentMatch.scores.p1 = 5;
  assert.equal(setMatchHitsToWin(highScoreRoom, 4).ok, false);
  assert.equal(highScoreRoom.currentMatch.hitsToWin, 3);
  assert.equal(setMatchHitsToWin(highScoreRoom, 10).ok, true);
  assert.equal(highScoreRoom.currentMatch.hitsToWin, 10);
  highScoreRoom.currentMatch.scores.p1 = 9;
  highScoreRoom.currentMatch.scores.p2 = 8;
  assert.equal(applyAction(highScoreRoom, "p1", "hit").outcome, "hit");
  assert.equal(highScoreRoom.currentMatch.scores.p1, 10);
});

test("bent nails halve the hit zone and NPCs have an even chance to straighten", () => {
  const player = createPlayer("p", "Player");
  assert.equal(swingStats(player, true).width, swingStats({ ...player, strength: 0 }).width / 2);

  const room = createRoom("BEND", "host");
  room.players = [createPlayer("human", "Human"), createPlayer("npc", "NPC", true)];
  seedTournament(room);
  startNextMatch(room);
  room.currentMatch.turnIndex = 1;
  room.currentMatch.bentIds = ["npc"];

  assert.equal(applyNpcTurn(room, () => 0.49).outcome, "straightened");
  assert.deepEqual(room.currentMatch.bentIds, []);
  assert.deepEqual(room.currentMatch.bonusIds, ["npc"]);
  assert.equal(confirmTurn(room, null, true).ok, true);

  room.currentMatch.turnIndex = 1;
  room.currentMatch.bentIds = ["npc"];
  const rolls = [0.5, 0.05];
  assert.equal(applyNpcTurn(room, () => rolls.shift()).outcome, "hit");
  assert.deepEqual(room.currentMatch.bentIds, ["npc"]);
});

test("best-of-three matches award a series after two games to the configured hit target", () => {
  const room = roomWithPlayers(2);
  room.defaultMatchSettings = { hitsToWin: 1, bestOf: 3, skipNpcOnly: false };
  seedTournament(room);
  startNextMatch(room);
  assert.equal(room.currentMatch.hitsToWin, 1);
  assert.equal(room.currentMatch.bestOf, 3);
  room.players[0].drunk = 4;
  room.players[1].drunk = 1;
  room.players[0].constitution = 1;
  room.players[1].constitution = 0;

  room.currentMatch.bentIds = ["p1", "p2"];
  winCurrentGame(room, "p1");
  assert.equal(room.currentMatch.gameWins.p1, 1);
  assert.deepEqual(room.players.map((player) => player.drunk), [2, 0]);
  assert.deepEqual(room.currentMatch.bentIds, []);
  assert.equal(room.currentMatch.turnIndex, 1);
  winCurrentGame(room, "p2");
  assert.equal(room.currentMatch.gameWins.p2, 1);
  assert.deepEqual(room.players.map((player) => player.drunk), [0, 0]);
  assert.equal(room.currentMatch.turnIndex, 0);
  winCurrentGame(room, "p1");
  assert.equal(room.currentMatch, null);
  assert.equal(room.history[0].winnerId, "p1");
  assert.deepEqual(room.history[0].scores, { p1: 2, p2: 1 });
  assert.equal(room.history[0].bestOf, 3);
});

test("the next bracket match receives its own configured hit target, series, and NPC skip choice", () => {
  const room = roomWithPlayers(4);
  startNextMatch(room);
  winCurrentMatch(room);
  room.nextMatchSettings = { hitsToWin: 3, bestOf: 3, skipNpcOnly: true };
  room.players[2].beersDrank = 2;
  room.players[2].drunk = 1;

  assert.equal(startNextMatch(room), true);
  assert.equal(room.currentMatch.hitsToWin, 3);
  assert.equal(room.currentMatch.bestOf, 3);
  assert.equal(room.currentMatch.skipNpcOnly, true);
  assert.equal(room.nextMatchSettings.skipNpcOnly, false);
  assert.equal(room.players[2].beersDrank, 0);
  assert.equal(room.players[2].drunk, 1);
  assert.equal(publicState(room).currentMatch.gameWins.p3, 0);
});

test("the host can award an active match to either participant with a 3/3 stump score", () => {
  const room = roomWithPlayers(4);
  startNextMatch(room);
  const [winnerId, loserId] = room.currentMatch.playerIds;

  assert.equal(awardMatchToWinner(room, "not-in-match"), false);
  assert.equal(awardMatchToWinner(room, winnerId), true);
  assert.equal(room.currentMatch, null);
  assert.equal(room.lastMatchStump.winnerId, winnerId);
  assert.equal(room.lastMatchStump.hitsToWin, 3);
  assert.equal(room.lastMatchStump.gameWins[winnerId], 1);
  assert.deepEqual(room.lastMatchStump.scores, { [winnerId]: 3, [loserId]: 0 });
  assert.equal(room.history[0].winnerId, winnerId);
});

test("best-of can be changed mid-match and immediately completes a newly satisfied series", () => {
  const room = roomWithPlayers(2);
  room.defaultMatchSettings = { hitsToWin: 1, bestOf: 3, skipNpcOnly: false };
  seedTournament(room);
  startNextMatch(room);

  winCurrentGame(room, "p1");
  assert.equal(room.currentMatch.gameWins.p1, 1);
  assert.equal(setMatchBestOf(room, 1).ok, true);
  assert.equal(room.currentMatch, null);
  assert.equal(room.history[0].winnerId, "p1");
  assert.equal(setMatchBestOf(room, 3).ok, false);
});

test("the host can manually play one NPC turn using the NPC's current match stats", () => {
  const room = createRoom("MANUAL", "host");
  room.players = [createPlayer("human", "Human"), createPlayer("npc", "NPC", true)];
  room.players[1].strength = 5;
  room.players[1].dexterity = 5;
  seedTournament(room);
  startNextMatch(room);
  room.currentMatch.turnIndex = 1;

  assert.equal(applyAction(room, "npc", "hit").ok, false);
  assert.equal(applyHostNpcAction(room, "npc", "hit", 50).outcome, "hit");
  assert.equal(room.currentMatch.scores.npc, 1);
  assert.equal(room.currentMatch.pendingAdvance.playerId, "npc");
  assert.equal(confirmTurn(room, null, true).ok, true);
});

test("a bullseye is recorded as two hits and emits a gold effect", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  const result = applyAction(room, "p1", "bullseye");
  assert.equal(result.ok, true);
  assert.equal(room.currentMatch.scores.p1, 2);
  assert.equal(room.currentMatch.lastSwing.position, 50);
  assert.equal(room.currentMatch.lastSwing.stats.criticalWidth, 2.75);
  assert.equal(room.currentMatch.pendingAdvance.playerId, "p1");
  assert.equal(room.currentMatch.hitEffect.kind, "bullseye");
  assert.equal(room.currentMatch.hitEffect.playerId, "p1");
  assert.equal(confirmTurn(room, "p1").ok, true);
});

test("players can configure zero-to-five stats and hosts can randomize seeds before the tournament", () => {
  const room = createRoom("SETUP", "host");
  room.players = ["a", "b", "c", "d"].map((id) => createPlayer(id, id));
  setPlayerStats(room.players[0], { strength: 0, dexterity: 5, constitution: 2, wisdom: 5 });
  assert.deepEqual(
    [room.players[0].strength, room.players[0].dexterity, room.players[0].constitution, room.players[0].wisdom],
    [0, 5, 2, 5]
  );
  assert.equal(randomizeBracket(room, () => 0), true);
  assert.deepEqual(room.players.map((player) => player.id), ["b", "c", "d", "a"]);
  room.phase = "tournament";
  assert.equal(randomizeBracket(room, () => 0), false);
});

test("restarting a match resets score, nail state, beers, and drunkenness", () => {
  const room = roomWithPlayers(2);
  startNextMatch(room);
  room.currentMatch.hitsToWin = 3;
  room.currentMatch.bestOf = 3;
  room.currentMatch.skipNpcOnly = true;
  room.currentMatch.scores.p1 = 2;
  room.currentMatch.bentIds = ["p1"];
  room.currentMatch.pendingDrinkPlayerId = "p2";
  room.players[0].beersDrank = 3;
  room.players[0].drunk = 2;
  room.players[1].beersDrank = 1;
  room.players[1].drunk = 1;
  assert.equal(restartCurrentMatch(room), true);
  assert.deepEqual(room.currentMatch.scores, { p1: 0, p2: 0 });
  assert.deepEqual(room.currentMatch.bentIds, []);
  assert.equal(room.currentMatch.pendingDrinkPlayerId, null);
  assert.equal(room.currentMatch.hitsToWin, 3);
  assert.equal(room.currentMatch.bestOf, 3);
  assert.equal(room.currentMatch.skipNpcOnly, true);
  assert.deepEqual(room.players.map((player) => [player.beersDrank, player.drunk]), [[0, 0], [0, 0]]);
  assert.equal(restartCurrentMatch({ phase: "tournament", currentMatch: null }), false);
});

test("tournament restart rebuilds the opening bracket and clears results while retaining configured stats", () => {
  const room = roomWithPlayers(4);
  room.players[0].strength = 0;
  startNextMatch(room);
  assert.equal(winCurrentMatch(room).ok, true);
  assert.equal(room.history.length, 1);

  seedTournament(room);
  assert.equal(room.history.length, 0);
  assert.equal(room.roundNumber, 1);
  assert.equal(room.players[0].strength, 0);
  assert.deepEqual(room.roundByes, []);
  assert.equal(publicState(room).roundLabel, "Winners Round 1");
  assert.equal(startNextMatch(room), true);
  assert.deepEqual(room.currentMatch.playerIds, ["p1", "p2"]);
});

test("three players get byes through the double-elimination bracket and crown a champion", () => {
  const room = roomWithPlayers(3);
  while (room.phase === "tournament") {
    if (!room.currentMatch && !startNextMatch(room)) break;
    winCurrentMatch(room);
  }
  assert.equal(room.phase, "complete");
  assert.ok(room.championId);
});
