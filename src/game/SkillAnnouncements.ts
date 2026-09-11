import type { SkillReadyNotice } from '../protocol.js';
import type { Room } from '../room/Room.js';
import { SKILL_CATALOG } from './SkillCatalog.js';
import { faction, publicSkills } from './SkillState.js';

/** Emit a condition once per opportunity. Chat/reconnect snapshots never retrigger it. */
export class SkillAnnouncements {
  private readonly emitted = new WeakMap<Room, { game: Room['game']; keys: Map<string, string> }>();
  public collect(room: Room): SkillReadyNotice[] {
    if (!room.game || room.status !== 'PLAYING' || room.game.lifecycle?.pause) return [];
    let history = this.emitted.get(room);
    if (history?.game !== room.game) { history = { game: room.game, keys: new Map() }; this.emitted.set(room, history); }
    const notices = new Map<string, string[]>();
    for (const skill of publicSkills(room)) {
      const definition = SKILL_CATALOG.find((s) => s.id === skill.skillId)!;
      const runtime = faction(room, skill.playerId);
      let opportunity = '';
      if (definition.kind === 'AWAKENING' && skill.awakened) opportunity = 'awakened';
      else if (skill.available) {
        opportunity = room.game.reaction?.playerId === skill.playerId ? `reaction:${room.game.reaction.id}`
          : skill.skillId === 'cn-grit' ? `upgrade:${runtime.level}`
          : ['uk-sun', 'uk-industry', 'cn-scale'].includes(skill.skillId) ? `roll:${room.game.rollId}` : `turn:${runtime.normalTurns}`;
      }
      const id = `${skill.playerId}:${skill.skillId}`;
      if (!opportunity || history!.keys.get(id) === opportunity) continue;
      history!.keys.set(id, opportunity);
      const ids = notices.get(skill.playerId) ?? []; ids.push(skill.skillId); notices.set(skill.playerId, ids);
    }
    return Array.from(notices, ([playerId, skillIds]) => ({ playerId, skillIds }));
  }
}
