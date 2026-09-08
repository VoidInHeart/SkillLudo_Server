/** Isolated local visual/integration verification, without MySQL or production sessions. */
import { GameWebSocketServer } from '../src/network/WebSocketServer.js';
const server = new GameWebSocketServer(Number(process.env.PORT ?? 3101));
await server.ready;
console.log(`Preview verification server: ${server.address()}`);
const close = async () => { await server.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
