import type WebSocket from 'ws';
import type { ServerMessage } from '../protocol.js';

export class ConnectionManager {
  private readonly sockets = new Map<string, WebSocket>();

  public bind(playerId: string, socket: WebSocket): void {
    const previous = this.sockets.get(playerId);
    if (previous && previous !== socket) previous.close(4001, '新连接已建立');
    this.sockets.set(playerId, socket);
  }

  public unbind(playerId: string, socket: WebSocket): void {
    if (this.sockets.get(playerId) === socket) this.sockets.delete(playerId);
  }

  public isBoundTo(playerId: string, socket: WebSocket): boolean {
    return this.sockets.get(playerId) === socket;
  }

  public send(playerId: string, message: ServerMessage): void {
    const socket = this.sockets.get(playerId);
    if (socket) this.sendSocket(socket, message);
  }

  public broadcast(playerIds: string[], message: ServerMessage): void {
    for (const playerId of playerIds) this.send(playerId, message);
  }

  public sendSocket(socket: WebSocket, message: ServerMessage): void {
    // OPEN is 1. Avoid importing WebSocket as a runtime value just for this constant.
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }
}
