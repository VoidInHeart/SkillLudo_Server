# 2026-09-09 容量测试证据

测试对象为生产配置镜像 `263459568ab3c00c3164632a41844bd724cd3229`。Node 服务单副本、CPU 限制 1 核、内存限制 768 MiB；MySQL 8.4.8。内网发生器是同节点的独立临时 Pod，公网发生器为开发者的 Windows 电脑。

- `capacity-*-result.json`：四个真实 WebSocket 一房间，所有房间持续投骰、选点、移动，并在每个阶段额外请求一次状态恢复；每阶段间隔 700 ms，每位玩家约每 10 秒发一次心跳。没有使用调试骰子或 AI 托管。
- `capacity-*-resources.json`：从宿主机读取游戏容器的 cgroup/进程计数，每秒采样，包含准备、稳定负载和结束阶段。Node RSS 不含压测客户端；宿主机可用内存包含发生器开销。
- `capacity-*-summary.json`：整个采样窗口摘要。容量报告中的平均 CPU 可按 result 的结束 timestamp 与 durationSeconds 选取稳定负载区间后计算。
- `capacity-public-*.json`：经公网 IP 和 Traefik 的实际玩家链路；应连同 errorCount、failedRooms 和完成速率一起看，失败档位的成功请求延迟不代表超时请求已被计入延迟分位数。

发生器属于等待响应后继续的闭环模型。发生拥塞时完成速率会下降；不能把 `commandsPerSecond` 当成固定施加的输入负载。统计的下行量是收到的应用层 WebSocket 消息，不含 TCP/IP 开销；本轮测试使用明文 WS，没有 TLS 压缩。

退出会清理临时房间和发生器 Pod。当前游客会话 Map 没有 TTL 淘汰，旧会话对象会留在服务进程中直到重启；本轮不构成长时间会话回收或数天内存稳定性验收。

复现内网档位：上传 `deploy/run-load.sh` 和 `deploy/sample-resources.py` 到 `/opt/skillludo` 后，在批准的测试窗口运行 `sudo bash /opt/skillludo/run-load.sh 100 45`。公网命令见上一级的 `部署与运维.md`。
