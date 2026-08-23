import { GameWebSocketServer } from './network/WebSocketServer.js';
import { SessionManager } from './auth/SessionManager.js';
import { UserRepository } from './auth/UserRepository.js';

const configuredPort = Number.parseInt(process.env.PORT ?? '3000', 10);
const users = new UserRepository();
await users.verifyConnection();
const server = new GameWebSocketServer(Number.isFinite(configuredPort) ? configuredPort : 3000, new SessionManager(users));
await server.ready;
console.info(`SkillLudo server listening on ${server.address()}`);

const shutdown = async (): Promise<void> => {
  console.info('Shutting down SkillLudo server...');
  await server.close();
  await users.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
