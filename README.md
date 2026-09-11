# SkillLudo Server

四阵营联机飞行棋的权威 Node.js 服务端，最多四参赛席加两观战席。房间和对局状态在内存中保存；客户端只能发送意图，骰子、可移动棋子、移动、撞机和排名均由服务端计算。

## 启动

使用 Node.js 24 和本机 MySQL，首次执行 `npm ci`，并按下一节准备数据库与 `.env`。随后可在本目录运行：

```powershell
# Windows PowerShell：编译后后台启动，关闭终端后继续运行
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1

# 前台运行，方便看实时输出，Ctrl+C 停止
.\start.ps1 -Foreground
```

```sh
# Linux / macOS / Git Bash
sh ./start.sh
# 前台运行
sh ./start.sh --foreground
```

脚本通过自身位置找到项目，支持从其他目录调用。默认监听 `ws://127.0.0.1:3000`；可在本机 `.env` 设置 `PORT`。两个入口共用 `scripts/start-local.mjs`：读取 `.env`、编译 TypeScript、启动后台进程并等待端口就绪。已有本脚本启动的实例时会报告原 PID 并直接返回；其他服务占用端口时会报错，不会终止占用者。缺少依赖时请先运行 `npm ci`。

后台输出追加到 `.runtime/server.out.log` 和 `.runtime/server.err.log`，PID、端口、启动时间保存在 `.runtime/server.json`；这些文件与 `.env` 均不入库。脚本不会自动重启崩溃的服务，也不设置开机启动。修改源码或 `.env` 后，需要先停止旧实例，再运行启动脚本。

停止本脚本启动的后台实例（先核对记录中的 PID 仍属于本项目的 `dist/index.js`；重启电脑后旧记录可能过期）：

```powershell
$serverState = Get-Content .\.runtime\server.json -Raw | ConvertFrom-Json
Get-CimInstance Win32_Process -Filter "ProcessId = $($serverState.pid)" | Select-Object ProcessId, CommandLine
# 确认后执行；服务停止会丢失内存中的房间和棋局
Stop-Process -Id $serverState.pid
```

Shell 可先用 `cat .runtime/server.json` 查看 PID，执行 `ps -p <PID> -o args=` 核对，再用 `kill <PID>` 停止。需要源码热重载时使用 `npm run dev`；发布构建仍可使用 `npm run build` 后执行 `npm start`。

## MySQL 账号与会话

服务端现在将注册账号、口令哈希和会话令牌保存到 MySQL；对局实时状态仍留在内存中，避免数据库成为回合操作瓶颈。首次使用时，使用本机终端临时设置密钥并初始化：

```powershell
$env:MYSQL_ROOT_PASSWORD = '<MySQL root 密码>'
$env:SKILLLUDO_DB_PASSWORD = '<SkillLudo 应用账号密码>'
npm run db:bootstrap
```

初始化完成后移除当前终端的 root 密码变量，后续启动只使用应用账号：

```powershell
Remove-Item Env:MYSQL_ROOT_PASSWORD
```

参考 `.env.example` 创建本地 `.env`，配置 `SKILLLUDO_DB_HOST`、`SKILLLUDO_DB_PORT`、`SKILLLUDO_DB_NAME`、`SKILLLUDO_DB_USER`、`SKILLLUDO_DB_PASSWORD`。默认数据库为 `skill_ludo`，应用账号为 `skillludo_app`。密码仅放本机 `.env`，不写进启动脚本或 Git；启动器也不会将继承的 `MYSQL_ROOT_PASSWORD` 传给服务进程。`.env` 作为配置数据解析，不作为 Shell 代码执行。

2026-09-09 已完成当前开发机的数据库初始化与应用账号连接验证；本机直接执行启动脚本即可，无需再次提供 root 密码。新机器仍需先初始化自己的数据库。

新增 WebSocket 消息：

- `REGISTER`：`{ username, password, nickname? }`，创建账号后返回 `AUTH_OK`。
- `LOGIN`：`{ username, password, nickname? }`，验证后返回 `AUTH_OK`。
- `AUTH`：仍支持旧的 `guestId` 试玩；账号会话使用返回的 `sessionId` 重连，即使服务器重启也有效。

数据表包括 `users`、`user_sessions`、`player_profiles` 和预留的 `game_records`。口令使用 Node `scrypt` 加盐哈希；数据库只保存会话令牌的 SHA-256 摘要。

## 协议 v4 与规则

- `AUTH`：开发环境使用持久化 `guestId` 换取/恢复 `sessionId`；正式账号可使用 `REGISTER` / `LOGIN`。
- `CREATE_ROOM`、`JOIN_ROOM`、`LEAVE_ROOM`：2–4 名参赛真人，不足四席补 AI，另有两观战席，六位数房间号；开局后加入自动观战。
- `READY`、`CANCEL_READY`、`START_GAME`：房主在所有当前玩家准备后开局。
- `SET_COLOR_PREFERENCE { roomId, color }`：`color` 为四种颜色、`null` 或 `SPECTATOR`；只在等待时可改，修改取消准备。参赛/观战席满时拒绝且不改变原身份。观战不参与准备和回合，房主即使观战仍可管理开局。
- `ROLL_DICE → WAIT_SELECT_DIE → COMMIT_MOVE { roomId, rollId, optionId, pieceId? }`：快照提供 `actionOptions` 的步数、合法飞机和预览。前端可任意切换预选，点击飞机一次验证并提交；只有所选方案无合法飞机时允许省略 pieceId 跳过。默认单骰 5/6 起飞、有效 6 连投；英国觉醒可合计相同双骰且不连投。旧 `SELECT_DIE / SELECT_PIECE` 供托管分步执行及重连兼容。
- `QUICK_MATCH`：暂时返回 `MATCHMAKING_DISABLED`。未来匹配房间使用 `MATCHMAKING` 模式，分配颜色忽略意愿。
- `USE_SKILL { roomId, rollId, skillId, targetPieceIds?, targetCell?, reactionId? }`：英国换位、法国救援/受击响应、中国强化、美国轰炸。改点技能通过 `COMMIT_MOVE` 的服务器选项执行，不能直接传自定义步数。技能变化广播 `SKILL_EFFECT`；受击响应使用 `WAIT_REACTION`，15 秒默认不锁定。
- `PING`、`RECONNECT`：45 秒心跳检测、session 重连、`GAME_STATE` 完整快照恢复。
- `REQUEST_PAUSE`、`VOTE_PAUSE { roomId, voteId, agree }`：未托管参赛真人发起，全体该类真人在 30 秒内全票通过后暂停 120 秒。冻结 AI、行动、受击和挂机截止时间；断线可重连。拒绝或超时不暂停，投票名单在发起时固定。
- `VOTE_CONTINUE { roomId, voteId, agree }`：冠军进入 `WINNER_VOTE`；全体真人含观战者 30 秒内至少 ceil(人数×75%) 同意才能继续，冠军不再行动，第二名产生即结束，仅一次继续机会。
- `lifecycle.activity`：当前需要行动的真人 30 秒无有效操作自动托管。聊天、PING 和本地预选不延期；重复请求不延期。`SKILL_READY` 配合系统聊天通知技能就绪/被动触发，供前端闪三次。

`src/game/GameRules.ts` 不依赖 WebSocket 或 Node UI，可独立测试：

```powershell
npm test
npm run check
npm run contract:check
```

`src/protocol.ts`、`src/game/PathData.ts` 与 `src/game/SkillCatalog.ts` 是两仓共享契约的源文件。修改后执行 `npm run contract:sync`，在前后端分别提交，再运行 `contract:check`；客户端镜像文件不要手改。协议 v4 与旧客户端不兼容，旧内存棋局不迁移，升级应成对发布两端。服务器 CI 中客户端 ref 必须固定到对应协议提交。

原图路径：起飞位置为进度 0，主环进度 1–50，私人跑道 51–56；同色格为进度 2 mod 4；虫洞 18→30，只撞击入口/出口。整次行动最多同色跳跃一次：14→18→30，或直接到 18 后 18→30→34；不会击毁中间普通格的飞机。服务器给出 `movePreviews`、`segments` 和 `captures`，客户端只播放结果。

颜色分配实现位于 `src/room/ColorAssignment.ts`：每种有人期望的颜色在该颜色候选者中等概率选一人；没有期望和未中签的玩家，与剩余颜色分别洗牌后配对。每人最多选一种颜色，因此该算法满足的意愿数就是被期望的不同颜色数，达到最大值。已穷举全部 625 种四人意愿组合，并验证每个冲突候选者都有中签机会。

技能目录在 `src/game/SkillCatalog.ts`，`SkillState.ts` 管理觉醒、CD、能量、强制后续效果和改点选项，`GameEngine.ts` 验证/结算技能与受击响应。CD 按己方正常回合计，连投不刷新；中国觉醒累积原始双骰严格超过 100；美国每击落一架敌机追加一组双骰。英国/中国改点均不连投。AI/托管不发动可选技能（含英国绑定、法国锁定、中国强化），自动被动和既存强制反向照常结算。

英国仅交换公共航线未锁定飞机，换入返家缺口以 `detour` 绕行。保留两机进终点跑道的觉醒条件，觉醒前新增一次绑定保命；`BoundPieces.ts` 处理同行、检查点落下和连带击毁。载机被第三方击毁后英国飞机获得一次诅咒，重新起飞后的首次行走固定 1。法国锁定最多两架，清格后选原始 3/4 解锁移动；救援逐机减一步、无击落和连投。中国三次强化依次免反向、连续三轮未用储备一次、范围 ±2；储备不启动/改变 CD，单个正常回合最多使用一次，CD 始终为 3。美国轰炸主环中心及前后各两格，含友机/锁定飞机，排除私有路线。

`npm test` 当前 80 项回归；`npm run verify:skill-fixtures` 导出七组权威计算场景，配合客户端 `verify:skills`、`verify:lifecycle` 检查正式构建点击和动画。`MatchLifecycle.ts` 的时钟用例不等待真实分钟，六连接网络用例另行验证权限、暂停重连、托管和第二名。夹具只在测试进程设置，不增加生产接口。两分钟封存支持网页退出，不承诺服务器进程重启后保留棋局。

浏览器验收专用服务执行 `npm run verify:server`，默认端口 3101、不需要 MySQL；它仅供开发，与正常数据库账号服务分离。阶段提交与恢复点见 `docs/重构进度日志.md`。

## 生产接入前

当前已部署到 `ws://81.70.145.148`，使用 k3s、独立 MySQL/PVC、单副本服务和 GitHub Actions 自动发布。健康检查为 `http://81.70.145.148/readyz`。部署账号、已配置的 GitHub Secret/Variable、日志与旧业务恢复方法见 [部署与运维](docs/部署与运维.md)。当前使用公网 IP，暂未配置 WSS 域名；发布镜像会中断内存中的棋局。

开发环境的 `SessionManager` 仅用于本地试玩。微信上线前，应在 HTTPS 接口中校验微信临时登录凭证并以 `openid` 创建服务端 session；同时将公网入口置于 TLS 反向代理后，以 `wss://` 供小游戏连接。
