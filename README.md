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

## 已实现的 MVP 协议

- `AUTH`：开发环境使用持久化 `guestId` 换取/恢复 `sessionId`；正式账号可使用 `REGISTER` / `LOGIN`。
- `CREATE_ROOM`、`JOIN_ROOM`、`LEAVE_ROOM`：2–4 人、六位数房间号。
- `READY`、`CANCEL_READY`、`START_GAME`：房主在所有当前玩家准备后开局。
- `ROLL_DICE`、`SELECT_PIECE`：状态机验证、服务端骰子、起飞/移动/跳跃/飞行/撞机/终点/排名。
- `PING`、`RECONNECT`：45 秒心跳检测、session 重连、`GAME_STATE` 完整快照恢复。

`src/game/GameRules.ts` 不依赖 WebSocket 或 Node UI，可独立测试：

```powershell
npm test
```

## 生产接入前

开发环境的 `SessionManager` 仅用于本地试玩。微信上线前，应在 HTTPS 接口中校验微信临时登录凭证并以 `openid` 创建服务端 session；同时将公网入口置于 TLS 反向代理后，以 `wss://` 供小游戏连接。
