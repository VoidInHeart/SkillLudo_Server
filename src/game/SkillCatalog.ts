import type { PlayerColor } from '../protocol.js';
export type SkillKind = 'LIMITED' | 'COOLDOWN' | 'AWAKENING' | 'NORMAL';
export const FACTION_NAMES: Record<PlayerColor, string> = { RED: '英国', YELLOW: '法国', BLUE: '中国', GREEN: '美国' };
export const SKILL_KIND_NAMES: Record<SkillKind, string> = { LIMITED: '限定技 · 每局一次', COOLDOWN: '冷却技能', AWAKENING: '觉醒技能', NORMAL: '普通技能' };
export interface SkillDescription { id: string; color: PlayerColor; name: string; kind: SkillKind; description: string; }
export const SKILL_CATALOG: readonly SkillDescription[] = [
  { id: 'uk-sun', color: 'RED', name: '日不落帝国', kind: 'LIMITED', description: '本次双骰之和达到 10 时，可交换公共航线上任意两架未锁定飞机的位置，敌我皆可。换入返家缺口的飞机须绕行公共航线，之后才能进入自己的终点跑道。' },
  { id: 'uk-apple', color: 'RED', name: '牛顿的苹果', kind: 'AWAKENING', description: '至少两架己方飞机进入终点跑道或完成航程后，永久解锁「工业革命」。' },
  { id: 'uk-industry', color: 'RED', name: '工业革命', kind: 'NORMAL', description: '觉醒后，预选点数时可选择 +1。双骰相同时，也可使用两骰之和；选择合计点数不获得 6 点连投，双 6 也不例外。' },
  { id: 'fr-tradition', color: 'YELLOW', name: '传统艺能', kind: 'NORMAL', description: '即将被击落时，可把飞机锁在原格，仍计为被击落；最多锁两架。其他未锁定飞机离开该格后，选择本次投出的 3 或 4，即可解锁并按该点数移动。15 秒未回应默认不锁定。' },
  { id: 'fr-paris', color: 'YELLOW', name: '困在巴黎的女孩', kind: 'LIMITED', description: '正常回合投骰前，解锁全部己方锁定飞机。每架依次获得一组额外双骰，选一点数减 1 后移动；救援不能击落飞机，也不连投。全部救援结束后，继续正常投骰。' },
  { id: 'cn-roar', color: 'BLUE', name: '雄狮之吼', kind: 'AWAKENING', description: '所有玩家投出的两枚原始骰点累计超过 50 后，永久解锁「尺有所长」。技能改点不计入累计。' },
  { id: 'cn-scale', color: 'BLUE', name: '尺有所长', kind: 'COOLDOWN', description: '觉醒后，预选点数可 +1 或 -1，冷却 3 个己方正常回合。下一正常回合首次行动必须反向调整同样幅度。连投不刷新冷却；有效步数最低为 0。' },
  { id: 'cn-grit', color: 'BLUE', name: '坚韧不拔', kind: 'NORMAL', description: '被击落后直接返回起飞处，并获得 1 点能量，上限 3。每消耗 3 点可强化已觉醒的「尺有所长」：第一重免除强制反向；第二重可调整 -2 至 +2；第三重冷却降至 2 回合。' },
  { id: 'us-war', color: 'GREEN', name: '战神附体', kind: 'NORMAL', description: '每击落一架敌机，立即获得一组额外双骰行动。同一回合可反复触发，与 6 点连投叠加。' },
  { id: 'us-bomb', color: 'GREEN', name: '核弹轰炸', kind: 'LIMITED', description: '指定公共航线的一格，击落该格和前后各两格内的所有飞机，包括己方与锁定飞机。范围首尾相连，不波及停机坪、起飞处或终点跑道。受击被动与击落奖励照常结算。' }
];
