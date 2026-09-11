/** Deterministic authority-calculated fixtures for client presentation tests only. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { GameEngine } from '../src/game/GameEngine.js';
import { GameRules } from '../src/game/GameRules.js';
import { RoomManager } from '../src/room/RoomManager.js';
import { faction, refreshAwakening } from '../src/game/SkillState.js';
import { getBoardCell, getPieceCell, positionOnRing } from '../src/game/PathData.js';
import type { PlayerColor } from '../src/protocol.js';

function setup(color: PlayerColor) {
  const colors: PlayerColor[] = ['RED', 'YELLOW', 'BLUE', 'GREEN'];
  const rooms = new RoomManager();
  const player = (id: string) => ({ id, sessionId: id, nickname: id, connected: true, lastHeartbeatAt: Date.now() });
  const room = rooms.createRoom(player('RED'));
  colors.slice(1).forEach((id) => rooms.joinRoom(room.roomId, player(id)));
  room.players.forEach((p) => { p.ready = true; p.preferredColor = p.id as PlayerColor; });
  const engine = new GameEngine(new GameRules(), () => 5 / 6); engine.startGame(room);
  const game = room.game!; game.currentPlayerIndex = colors.indexOf(color); faction(room, color).normalTurns = 1;
  const piece = (id: string) => game.pieces.find((p) => p.id === id)!;
  const at = (id: string, progress: number) => Object.assign(piece(id), { progress, state: progress >= 51 ? 'FINAL_PATH' : 'MAIN_PATH' });
  return { room, engine, game, piece, at };
}
const fixtures = [];
{
  const s = setup('RED'); s.at('red-1', 1); s.at('red-2', 51); s.at('red-3', 52); s.at('yellow-1', 25);
  s.engine.rollDice(s.room, 'RED', 6);
  const snapshot = s.engine.getSnapshot(s.room);
  const effect = s.engine.useSkill(s.room, 'RED', { roomId: s.room.roomId, rollId: s.game.rollId, skillId: 'uk-sun', targetPieceIds: ['red-1', 'yellow-1'] }).effect;
  fixtures.push({ name: 'britain', playerId: 'RED', snapshot, effect, after: s.engine.getSnapshot(s.room) });
}
{
  const s = setup('BLUE'); s.at('blue-1', 2); s.game.rolledTotal = 101; refreshAwakening(s.room);
  Object.assign(faction(s.room, 'BLUE'), { energy: 3, level: 3 }); s.engine.rollDice(s.room, 'BLUE', 4);
  const snapshot = s.engine.getSnapshot(s.room);
  const move = s.engine.commitMove(s.room, 'BLUE', { roomId: s.room.roomId, rollId: s.game.rollId, optionId: 'cn-0--2', pieceId: 'blue-1' }).move;
  fixtures.push({ name: 'china', playerId: 'BLUE', snapshot, move, after: s.engine.getSnapshot(s.room) });
}
{
  const s = setup('GREEN'); s.at('green-1', 1); s.at('yellow-1', 45); s.at('yellow-2', 45); s.engine.rollDice(s.room, 'GREEN', 1);
  s.engine.commitMove(s.room, 'GREEN', { roomId: s.room.roomId, rollId: s.game.rollId, optionId: 'die-0', pieceId: 'green-1' });
  const snapshot = s.engine.getSnapshot(s.room);
  const move = s.engine.resolveReaction(s.room, ['yellow-1'], snapshot.reaction!.id).move;
  fixtures.push({ name: 'france', playerId: 'YELLOW', snapshot, move, after: s.engine.getSnapshot(s.room) });
}
{
  const s = setup('GREEN'); Object.assign(s.piece('blue-1'), { state: 'MAIN_PATH' }, positionOnRing('BLUE', 'M0')); Object.assign(s.piece('red-1'), { state: 'MAIN_PATH' }, positionOnRing('RED', 'M51'));
  const snapshot = s.engine.getSnapshot(s.room);
  const effect = s.engine.useSkill(s.room, 'GREEN', { roomId: s.room.roomId, rollId: 0, skillId: 'us-bomb', targetCell: 'M0' }).effect;
  fixtures.push({ name: 'america', playerId: 'GREEN', snapshot, effect, after: s.engine.getSnapshot(s.room) });
}
const output = new URL('../../SkillLudo_Client/docs/verification/', import.meta.url);
{
  const s = setup('YELLOW'); s.at('yellow-1', 8); s.at('yellow-2', 12); s.piece('yellow-1').locked = true; s.piece('yellow-2').locked = true;
  const snapshot = s.engine.getSnapshot(s.room);
  const effect = s.engine.useSkill(s.room, 'YELLOW', { roomId: s.room.roomId, rollId: 0, skillId: 'fr-paris' }).effect;
  fixtures.push({ name: 'paris', playerId: 'YELLOW', snapshot, effect, after: s.engine.getSnapshot(s.room) });
}
{
  const s = setup('GREEN'); s.at('green-1', 17);
  Object.assign(s.at('red-1', 1), positionOnRing('RED', getBoardCell('GREEN', 18)!));
  s.engine.rollDice(s.room, 'GREEN', 1);
  s.engine.commitMove(s.room, 'GREEN', { roomId: s.room.roomId, rollId: s.game.rollId, optionId: 'die-0', pieceId: 'green-1' });
  const snapshot = s.engine.getSnapshot(s.room);
  const move = s.engine.resolveReaction(s.room, ['red-1'], snapshot.reaction!.id).move;
  fixtures.push({ name: 'binding', playerId: 'RED', snapshot, move, after: s.engine.getSnapshot(s.room) });
}
{
  const s = setup('GREEN'), carrier = s.at('green-1', 36), passenger = s.at('red-1', 1);
  Object.assign(passenger, positionOnRing('RED', getPieceCell(carrier)!), { boundTo: carrier.id });
  s.engine.rollDice(s.room, 'GREEN', 2);
  const snapshot = s.engine.getSnapshot(s.room);
  const move = s.engine.commitMove(s.room, 'GREEN', { roomId: s.room.roomId, rollId: s.game.rollId, optionId: 'die-0', pieceId: carrier.id }).move;
  fixtures.push({ name: 'checkpoint', playerId: 'GREEN', snapshot, move, after: s.engine.getSnapshot(s.room) });
}
mkdirSync(output, { recursive: true }); writeFileSync(new URL('skill-fixtures.json', output), JSON.stringify(fixtures, null, 2));
console.log(`Exported ${fixtures.length} skill presentation fixtures.`);
