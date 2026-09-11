import assert from 'node:assert/strict';
import test from 'node:test';
import { GameEngine } from '../src/game/GameEngine.js';
import { GameRules } from '../src/game/GameRules.js';
import { RoomManager } from '../src/room/RoomManager.js';
import { beginNormalTurn, faction, refreshAwakening } from '../src/game/SkillState.js';
import { getBoardCell, getPieceCell, positionOnRing } from '../src/game/PathData.js';
import { describeSkill } from '../src/game/SkillCatalog.js';
import type { PlayerColor, SkillCommand } from '../src/protocol.js';

const colors: PlayerColor[] = ['RED', 'YELLOW', 'BLUE', 'GREEN'];

test('L01: wormholes capture endpoints only, and share a single jump budget on all four routes', () => {
  for (const color of colors) for (const start of [13, 17]) {
    const s = setup(color), enemy = color === 'BLUE' ? 'RED' : 'BLUE';
    s.at(color, start);
    [18, 27, 30, 34].forEach((progress, index) => Object.assign(s.at(enemy, 1, index + 1), positionOnRing(enemy, getBoardCell(color, progress)!)));
    const move = new GameRules().calculateMove(s.game, color, s.piece(color).id, 1);
    assert.deepEqual(move.segments.map((segment) => segment.kind), start === 13 ? ['WALK', 'JUMP', 'FLIGHT'] : ['WALK', 'FLIGHT', 'JUMP']);
    assert.equal(move.toProgress, start === 13 ? 30 : 34);
    assert.deepEqual(move.captures.map((capture) => capture.atProgress), start === 13 ? [18, 30] : [18, 30, 34]);
    assert.ok(!move.killedPieceIds.includes(s.piece(enemy, 2).id));
  }
});

test('L02: modified sixes never repeat, while an unmodified rolled six still does', () => {
  for (const color of ['RED', 'BLUE'] as const) {
    const s = setup(color); s.at(color, 1); faction(s.room, color).awakened = true; s.roll(5, 6);
    const id = color === 'RED' ? 'uk-plus-0' : 'cn-0-1';
    const option = s.engine.getActionOptions(s.room).find((o) => o.id === id)!;
    assert.equal(option.dice, 6); assert.equal(option.extraTurn, false);
    assert.equal(s.engine.getActionOptions(s.room).find((o) => o.id === 'die-1')!.extraTurn, true);
    assert.equal(s.commit(id, s.piece(color).id).move!.extraTurn, false);
  }
});

test('L03: China stores at most one charge after three unused turns; spending it preserves CD and limits the whole turn', () => {
  const s = setup('BLUE'); s.at('BLUE', 1);
  const state = faction(s.room, 'BLUE'); Object.assign(state, { awakened: true, level: 2 });
  beginNormalTurn(s.room, 'BLUE'); beginNormalTurn(s.room, 'BLUE'); assert.ok(!state.storedCharge);
  beginNormalTurn(s.room, 'BLUE'); assert.equal(state.storedCharge, true);
  state.readyAtTurn = 9; s.roll(5, 6);
  const options = s.engine.getActionOptions(s.room);
  assert.ok(options.some((o) => o.usesStoredCharge));
  assert.ok(options.filter((o) => o.kind === 'CN_SHIFT').every((o) => o.usesStoredCharge && Math.abs(o.delta!) === 1));
  s.commit('cn-stored-0-1', s.piece('BLUE').id);
  assert.equal(state.readyAtTurn, 9); assert.equal(state.storedCharge, false); assert.equal(state.lastScaleTurn, 4);
  s.turn('BLUE'); s.roll(6); state.storedCharge = true;
  assert.ok(s.engine.getActionOptions(s.room).every((o) => o.kind === 'STANDARD'), 'neither saved nor normal skill can be used twice in the same normal turn');
  state.storedCharge = false;
  beginNormalTurn(s.room, 'BLUE'); beginNormalTurn(s.room, 'BLUE'); assert.equal(state.storedCharge, false);
  beginNormalTurn(s.room, 'BLUE'); assert.equal(state.storedCharge, true);
  beginNormalTurn(s.room, 'BLUE'); assert.equal(state.storedCharge, true);
});

test('L04: upgraded Chinese descriptions match the actual range, stored charge and unchanged cooldown', () => {
  assert.match(describeSkill('cn-scale', { level: 0 }), /必须反向/);
  assert.match(describeSkill('cn-scale', { level: 1 }), /已免除/);
  assert.match(describeSkill('cn-scale', { level: 2 }), /储备一次/);
  assert.doesNotMatch(describeSkill('cn-scale', { level: 2 }), /调整 -2/);
  assert.match(describeSkill('cn-scale', { level: 3 }), /调整 -2/);
  assert.match(describeSkill('cn-scale', { level: 3 }), /冷却 3/);
});
function setup(current: PlayerColor = 'RED') {
  let second = 1;
  const rooms = new RoomManager();
  const player = (id: string) => ({ id, sessionId: id, nickname: id, connected: true, lastHeartbeatAt: Date.now() });
  const room = rooms.createRoom(player('RED'));
  colors.slice(1).forEach((id) => rooms.joinRoom(room.roomId, player(id)));
  room.players.forEach((p) => { p.ready = true; p.preferredColor = p.id as PlayerColor; });
  const engine = new GameEngine(new GameRules(), () => (second - 1) / 6);
  engine.startGame(room);
  const game = room.game!;
  const turn = (color: PlayerColor) => {
    game.currentPlayerIndex = colors.indexOf(color); game.phase = 'WAIT_ROLL'; game.extraRolls = 0; game.selectedAction = undefined;
    faction(room, color).normalTurns ||= 1;
  };
  turn(current);
  const piece = (color: PlayerColor, n = 1) => game.pieces.find((p) => p.id === `${color.toLowerCase()}-${n}`)!;
  const at = (color: PlayerColor, progress: number, n = 1) => {
    const p = piece(color, n); p.progress = progress; p.state = progress >= 51 ? progress === 56 ? 'FINISHED' : 'FINAL_PATH' : 'MAIN_PATH'; p.locked = false; p.detour = false; return p;
  };
  const roll = (a: number, b = 1) => { second = b; return engine.rollDice(room, room.players[game.currentPlayerIndex].id, a); };
  const commit = (optionId: string, pieceId?: string) => engine.commitMove(room, room.players[game.currentPlayerIndex].id, { roomId: room.roomId, rollId: game.rollId, optionId, pieceId });
  const skill = (skillId: string, data: Partial<SkillCommand> = {}, owner = room.players[game.currentPlayerIndex].id) => engine.useSkill(room, owner, { roomId: room.roomId, rollId: game.rollId, skillId, ...data });
  return { room, game, engine, turn, piece, at, roll, commit, skill };
}

test('K01: awakening thresholds use raw dice and permanently unlock each faction', () => {
  const s = setup();
  s.game.rolledTotal = 98; s.roll(1, 1);
  assert.equal(faction(s.room, 'BLUE').awakened, false);
  s.commit('die-0'); s.roll(1, 1);
  assert.equal(faction(s.room, 'BLUE').awakened, true);
  s.at('RED', 51); s.at('RED', 56, 2); refreshAwakening(s.room);
  assert.equal(faction(s.room, 'RED').awakened, true);
  s.piece('RED').state = 'AIRPORT'; refreshAwakening(s.room);
  assert.equal(faction(s.room, 'RED').awakened, true);
});

test('K02: Britain adds one or combines doubles, and summed sixes never repeat the turn', () => {
  const s = setup(); s.at('RED', 51, 2); s.at('RED', 56, 3); s.at('RED', 1);
  s.roll(6, 6);
  const options = s.engine.getActionOptions(s.room);
  assert.equal(options.find((o) => o.id === 'uk-plus-0')!.dice, 7);
  assert.equal(options.find((o) => o.id === 'uk-sum')!.dice, 12);
  const result = s.commit('uk-sum', s.piece('RED').id).move!;
  assert.equal(result.extraTurn, false);
  assert.equal(s.game.currentPlayerIndex, 1);
  assert.equal(s.piece('RED').progress, 13);
});

test('K03: all 52 ring cells map through swap detours without becoming another private runway', () => {
  for (const color of colors) for (let index = 0; index < 52; index += 1) {
    const position = positionOnRing(color, `M${index}`);
    assert.equal(getBoardCell(color, position.progress, position.detour), `M${index}`);
    assert.ok(position.progress >= -1 && position.progress <= 50);
  }
  const s = setup(); s.at('RED', 1); s.at('YELLOW', 25); s.roll(6, 4);
  s.skill('uk-sun', { targetPieceIds: [s.piece('RED').id, s.piece('YELLOW').id] });
  assert.equal(s.piece('RED').detour, true); assert.equal(s.piece('RED').progress, -1);
  assert.equal(getPieceCell(s.piece('RED')), 'M24');
  const moved = s.commit('die-0', s.piece('RED').id).move!;
  assert.deepEqual(moved.segments[0].path, [0, 1, 2, 3, 4, 5]);
  assert.equal(s.piece('RED').state, 'MAIN_PATH'); assert.equal(s.piece('RED').detour, false);
});

test('K04: invalid or repeated swap requests do not consume or repeat the limited skill', () => {
  const s = setup(); s.at('RED', 1); s.at('BLUE', 2); s.roll(6, 4);
  const before = structuredClone(s.game);
  for (const ids of [[s.piece('RED').id, s.piece('RED').id], [s.piece('RED').id, s.piece('YELLOW').id], ['missing', s.piece('BLUE').id]]) {
    assert.throws(() => s.skill('uk-sun', { targetPieceIds: ids })); assert.deepEqual(s.game, before);
  }
  s.skill('uk-sun', { targetPieceIds: [s.piece('RED').id, s.piece('BLUE').id] });
  const after = structuredClone(s.game);
  assert.throws(() => s.skill('uk-sun', { targetPieceIds: [s.piece('RED').id, s.piece('BLUE').id] }));
  assert.deepEqual(s.game, after);
});

function frenchCapture() {
  const s = setup('GREEN'); s.at('GREEN', 1); s.at('YELLOW', 45); s.at('YELLOW', 45, 2); s.roll(1);
  const result = s.commit('die-0', s.piece('GREEN').id).move!;
  return { ...s, result };
}

test('K05: French response reserves the action, locks selected victims and still rewards the attacker', () => {
  const s = frenchCapture();
  assert.equal(s.result.pendingReaction, true); assert.equal(s.game.phase, 'WAIT_REACTION');
  assert.equal(s.piece('GREEN').progress, 1, 'no early movement while the defender is deciding');
  const reaction = s.engine.getSnapshot(s.room).reaction!;
  assert.equal(reaction.capacity, 2); assert.equal(reaction.pieceIds.length, 2);
  reaction.pieceIds.pop(); assert.equal(s.game.reaction!.pieceIds.length, 2);
  const answer = s.skill('fr-lock', { reactionId: reaction.id, targetPieceIds: [s.piece('YELLOW').id] }, 'YELLOW');
  assert.equal(answer.move!.captureOutcomes!.find((c) => c.pieceId === s.piece('YELLOW').id)!.outcome, 'LOCKED');
  assert.equal(s.piece('YELLOW').locked, true); assert.equal(s.piece('YELLOW', 2).state, 'AIRPORT');
  assert.equal(s.game.currentPlayerIndex, 3); assert.equal(s.game.extraRolls, 1, 'two captures create two extra rolls, first ready now');
  assert.throws(() => s.skill('fr-lock', { reactionId: reaction.id, targetPieceIds: [] }, 'YELLOW'));
});

test('K06: French locks enforce capacity, clear-cell requirement and actual 3/4 selection', () => {
  const s = frenchCapture(), reaction = s.game.reaction!;
  const before = structuredClone(s.game);
  assert.throws(() => s.skill('fr-lock', { reactionId: reaction.id, targetPieceIds: [...reaction.pieceIds, s.piece('YELLOW', 3).id] }, 'YELLOW'));
  assert.deepEqual(s.game, before);
  s.skill('fr-lock', { reactionId: reaction.id, targetPieceIds: reaction.pieceIds }, 'YELLOW');
  s.turn('YELLOW'); s.roll(3, 4);
  assert.ok(s.engine.getActionOptions(s.room).every((o) => !o.movablePieceIds.includes(s.piece('YELLOW').id)));
  s.at('GREEN', 10);
  assert.ok(s.engine.getActionOptions(s.room)[0].movablePieceIds.includes(s.piece('YELLOW').id));
  s.commit('die-0', s.piece('YELLOW').id);
  assert.equal(s.piece('YELLOW').locked, false); assert.equal(s.piece('YELLOW').progress, 48);
});

test('K07: expired or trustee defensive choices default to normal capture', () => {
  const s = frenchCapture(); s.game.reaction!.expiresAt = Date.now() - 1;
  assert.throws(() => s.skill('fr-lock', { reactionId: s.game.reaction!.id, targetPieceIds: [] }, 'YELLOW'));
  s.engine.resolveReaction(s.room, [], s.game.reaction!.id);
  assert.equal(s.piece('YELLOW').state, 'AIRPORT');
  const ai = setup('GREEN'); ai.at('GREEN', 1); ai.at('YELLOW', 45); ai.room.players[1].aiControlled = true; ai.roll(1);
  const result = ai.commit('die-0', ai.piece('GREEN').id).move!;
  assert.ok(!result.pendingReaction); assert.equal(ai.piece('YELLOW').state, 'AIRPORT');
});

test('K08: Paris rescues every unlocked plane once, without captures, before the normal roll', () => {
  const s = setup('YELLOW'); s.at('YELLOW', 1).locked = true; s.at('YELLOW', 8, 2).locked = true;
  s.at('RED', 30); const enemyBefore = structuredClone(s.piece('RED'));
  s.skill('fr-paris'); assert.equal(s.game.rescue!.pieceIds.length, 2);
  s.roll(4, 6); const rescue = s.engine.getActionOptions(s.room).find((o) => o.id === 'rescue-0')!;
  assert.equal(rescue.dice, 3); assert.ok(Object.values(rescue.movePreviews).every((move) => !move.killedPieceIds.length));
  s.commit('rescue-0', s.piece('YELLOW').id);
  assert.equal(s.game.rescue!.pieceIds.length, 1); assert.deepEqual(s.piece('RED'), enemyBefore);
  s.roll(1, 1); s.commit('rescue-0', s.piece('YELLOW', 2).id);
  assert.equal(s.game.rescue, undefined); assert.equal(s.game.currentPlayerIndex, 1);
  assert.equal(faction(s.room, 'YELLOW').rolledThisTurn, false);
  assert.equal(s.piece('YELLOW', 2).progress, 8, 'one minus one stays still and does not trigger a jump');
  s.roll(2); assert.equal(faction(s.room, 'YELLOW').rolledThisTurn, true);
  assert.throws(() => s.skill('fr-paris'));
});

test('K09: Chinese cooldown counts normal turns and the next normal action must reverse direction', () => {
  const s = setup('BLUE'); s.game.rolledTotal = 101; s.at('BLUE', 1); s.roll(3);
  s.commit('cn-0-1', s.piece('BLUE').id);
  const state = faction(s.room, 'BLUE'); assert.equal(state.pendingDelta, -1); assert.equal(state.readyAtTurn, 4);
  beginNormalTurn(s.room, 'BLUE'); s.turn('BLUE'); s.roll(1, 2);
  const options = s.engine.getActionOptions(s.room);
  assert.ok(options.every((o) => o.mandatory)); assert.equal(options[0].dice, 0);
  const before = structuredClone(s.game);
  assert.throws(() => s.commit('die-0', s.piece('BLUE').id)); assert.deepEqual(s.game, before);
  s.commit('forced-0', s.piece('BLUE').id); assert.equal(state.forcedDelta, 0);
  beginNormalTurn(s.room, 'BLUE'); s.turn('BLUE'); s.roll(2);
  assert.ok(s.engine.getActionOptions(s.room).every((o) => o.kind === 'STANDARD'));
  s.commit('die-0', s.piece('BLUE').id);
  beginNormalTurn(s.room, 'BLUE'); s.turn('BLUE'); s.roll(2);
  assert.ok(s.engine.getActionOptions(s.room).some((o) => o.kind === 'CN_SHIFT'));
});

test('K10: Chinese capture returns to takeoff, caps energy and supports all three upgrades', () => {
  const s = setup('GREEN');
  for (let n = 1; n <= 4; n += 1) s.at('BLUE', 1, n);
  s.skill('us-bomb', { targetCell: getPieceCell(s.piece('BLUE'))! });
  assert.ok(s.game.pieces.filter((p) => p.color === 'BLUE').every((p) => p.state === 'MAIN_PATH' && p.progress === 0));
  const state = faction(s.room, 'BLUE'); assert.equal(state.energy, 3);
  s.turn('BLUE'); assert.throws(() => s.skill('cn-upgrade'));
  state.awakened = true; state.pendingDelta = -1;
  s.skill('cn-upgrade'); assert.equal(state.level, 1); assert.equal(state.pendingDelta, 0); assert.equal(state.energy, 0);
  state.energy = 3; s.skill('cn-upgrade'); s.roll(1, 6);
  const options = s.engine.getActionOptions(s.room);
  assert.ok(options.every((o) => Math.abs(o.delta ?? 0) <= 1)); assert.ok(options.every((o) => o.dice >= 0));
  state.energy = 3; s.skill('cn-upgrade'); s.commit('cn-1-2', s.piece('BLUE').id);
  assert.equal(state.level, 3); assert.equal(state.readyAtTurn - state.normalTurns, 3); assert.equal(state.pendingDelta, 0);
});

test('K11: nuclear range wraps, includes allies and locks, and excludes private cells', () => {
  const s = setup('GREEN');
  Object.assign(s.at('RED', 1), positionOnRing('RED', 'M51'));
  Object.assign(s.at('GREEN', 1), positionOnRing('GREEN', 'M0'));
  Object.assign(s.at('YELLOW', 1), positionOnRing('YELLOW', 'M1')); s.piece('YELLOW').locked = true;
  s.at('BLUE', 51); s.at('GREEN', 0, 2);
  const before = structuredClone(s.game);
  assert.throws(() => s.skill('us-bomb', { targetCell: 'F-BLUE-0' })); assert.deepEqual(s.game, before);
  const result = s.skill('us-bomb', { targetCell: 'M0' });
  assert.deepEqual(result.effect!.targetCells, ['M50', 'M51', 'M0', 'M1', 'M2']);
  assert.equal(result.effect!.captures!.length, 3);
  assert.equal(s.piece('RED').state, 'AIRPORT'); assert.equal(s.piece('GREEN').state, 'AIRPORT'); assert.equal(s.piece('YELLOW').state, 'AIRPORT');
  assert.equal(s.piece('BLUE').state, 'FINAL_PATH'); assert.equal(s.piece('GREEN', 2).progress, 0);
  assert.equal(s.game.extraRolls, 2, 'self-capture grants no bonus');
  assert.throws(() => s.skill('us-bomb', { targetCell: 'M1' }));
});

test('K12: trustee never activates optional skills but still obeys existing mandatory effects', () => {
  for (const color of colors) {
    const s = setup(color), state = faction(s.room, color); state.awakened = true; state.energy = 3;
    s.room.players[colors.indexOf(color)].aiControlled = true; s.roll(6, 6);
    assert.ok(s.engine.getActionOptions(s.room).every((o) => o.kind === 'STANDARD'));
    assert.ok(s.engine.getSnapshot(s.room).skills.filter((skill) => skill.playerId === color).every((skill) => !skill.available));
    assert.throws(() => s.skill(color === 'RED' ? 'uk-sun' : color === 'GREEN' ? 'us-bomb' : color === 'BLUE' ? 'cn-upgrade' : 'fr-paris'));
  }
  const s = setup('BLUE'); faction(s.room, 'BLUE').forcedDelta = -1; s.room.players[2].aiControlled = true;
  s.at('BLUE', 0); s.roll(3, 4);
  const index = s.engine.chooseAiDie(s.room, 'BLUE');
  s.engine.selectDie(s.room, 'BLUE', index, s.game.rollId);
  assert.equal(faction(s.room, 'BLUE').forcedDelta, 0);
  s.engine.selectPiece(s.room, 'BLUE', s.engine.chooseAiPiece(s.room, 'BLUE')!);
});
