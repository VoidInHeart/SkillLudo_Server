# SkillLudo Server

四人联机飞行棋的权威 Node.js 服务端。房间和对局状态在内存中保存；客户端只能发送意图，骰子、可移动棋子、移动、撞机和排名均由服务端计算。

## 启动

```powershell
npm install
npm run dev
```

默认监听 `ws://localhost:3000`。发布构建使用 `npm run build` 后执行 `npm start`。

## MySQL 账号与会话

服务端现在将注册账号、口令哈希和会话令牌保存到 MySQL；对局实时状态仍留在内存中，避免数据库成为回合操作瓶颈。首次使用时，使用本机终端临时设置密钥并初始化：

```powershell
$env:MYSQL_ROOT_PASSWORD = '<MySQL root 密码>'
$env:SKILLLUDO_DB_PASSWORD = '<SkillLudo 应用账号密码>'
npm run db:bootstrap
```

之后每次启动服务端只需要应用账号配置，参考 `.env.example`（真实密码不要提交到 Git）：

```powershell
$env:SKILLLUDO_DB_PASSWORD = '<SkillLudo 应用账号密码>'
npm run dev
```

新增 WebSocket 消息：

- `REGISTER`：`{ username, password, nickname? }`，创建账号后返回 `AUTH_OK`。
- `LOGIN`：`{ username, password, nickname? }`，验证后返回 `AUTH_OK`。
- `AUTH`：仍支持旧的 `guestId` 试玩；账号会话使用返回的 `sessionId` 重连，即使服务器重启也有效。

数据表包括 `users`、`user_sessions`、`player_profiles` 和预留的 `game_records`。口令使用 Node `scrypt` 加盐哈希；数据库只保存会话令牌的 SHA-256 摘要。

## 协议 v2 与规则

- `AUTH`：开发环境使用持久化 `guestId` 换取/恢复 `sessionId`；正式账号可使用 `REGISTER` / `LOGIN`。
- `CREATE_ROOM`、`JOIN_ROOM`、`LEAVE_ROOM`：2–4 人、六位数房间号。
- `READY`、`CANCEL_READY`、`START_GAME`：房主在所有当前玩家准备后开局。
- `SET_COLOR_PREFERENCE { roomId, color }`：`color` 为四种颜色或 `null`；只在房间等待时可改，修改会取消本人的准备。开局按颜色意愿抽签后创建棋子。
- `ROLL_DICE → WAIT_SELECT_DIE → SELECT_DIE { roomId, dieIndex, rollId } → WAIT_SELECT_PIECE → SELECT_PIECE { roomId, pieceId, rollId }`：服务端生成两枚骰子，选择索引 0/1；点数不相加，5/6 起飞，所选 6 连投。两个点数一样也只选一个；无棋可走则换人。
- `QUICK_MATCH`：暂时返回 `MATCHMAKING_DISABLED`。未来匹配房间使用 `MATCHMAKING` 模式，分配颜色忽略意愿。
- `USE_SKILL`：预留命令和技能窗口/状态，当前所有阵营技能为空，返回 `SKILL_UNAVAILABLE`。
- `PING`、`RECONNECT`：45 秒心跳检测、session 重连、`GAME_STATE` 完整快照恢复。

`src/game/GameRules.ts` 不依赖 WebSocket 或 Node UI，可独立测试：

```powershell
npm test
npm run check
npm run contract:check
```

`src/protocol.ts` 与 `src/game/PathData.ts` 是两仓共享契约的源文件。修改后执行 `npm run contract:sync`，在前后端分别提交，再运行 `contract:check`；客户端镜像文件不要手改。协议 v2 与旧客户端不兼容，旧内存棋局不迁移，升级应结束旧局并成对发布两端。

原图路径：起飞位置为进度 0，主环进度 1–50，私人跑道 51–56；同色格为进度 2 mod 4；虫洞 18→30，支持同色跳跃 14→18 后进入虫洞。服务器给出 `movePreviews`、移动段 `segments` 和撞击位置 `captures`，客户端只播放这些结果。

颜色分配实现位于 `src/room/ColorAssignment.ts`：每种有人期望的颜色在该颜色候选者中等概率选一人；没有期望和未中签的玩家，与剩余颜色分别洗牌后配对。每人最多选一种颜色，因此该算法满足的意愿数就是被期望的不同颜色数，达到最大值。已穷举全部 625 种四人意愿组合，并验证每个冲突候选者都有中签机会。

技能扩展入口为 `src/game/FactionSkills.ts`，已定义阵营、次数、冷却、允许窗口和激活验证。后续具体技能需要在服务端实现效果结算与状态写入，然后随快照广播，不能由客户端动画修改规则状态。

浏览器验收专用服务执行 `npm run verify:server`，默认端口 3101、不需要 MySQL；它仅供开发，与正常数据库账号服务分离。阶段提交与恢复点见 `docs/重构进度日志.md`。

## 生产接入前

开发环境的 `SessionManager` 仅用于本地试玩。微信上线前，应在 HTTPS 接口中校验微信临时登录凭证并以 `openid` 创建服务端 session；同时将公网入口置于 TLS 反向代理后，以 `wss://` 供小游戏连接。
