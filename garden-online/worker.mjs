import { DurableObject } from 'cloudflare:workers';

const origins = new Set([
  'https://www.burgerblox.se',
  'https://burgerblox.se',
  'https://birgerkling.github.io',
]);

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return new Response('Garden Defence lobby online');
    if (pathname !== '/lobby') return new Response('Not found', { status: 404 });
    if (!origins.has(request.headers.get('Origin'))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }
    return env.LOBBY.get(env.LOBBY.idFromName('garden-lobby')).fetch(request);
  },
};

export class GardenLobby extends DurableObject {
  fetch() {
    if (this.ctx.getWebSockets().length >= 100) {
      return new Response('Lobby full', { status: 503 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), x: 500, y: 440, updated: 0 });
    server.send(JSON.stringify({ self: server.deserializeAttachment().id }));
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 128) return;
    const player = socket.deserializeAttachment();
    const now = Date.now();
    if (now - player.updated < 200) return;
    let position;
    try { position = JSON.parse(message); } catch { return; }
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
    player.x = Math.max(25, Math.min(975, position.x));
    player.y = Math.max(45, Math.min(565, position.y));
    player.updated = now;
    socket.serializeAttachment(player);
    this.broadcast();
  }

  webSocketClose(socket, code) {
    if (socket.readyState !== 3) socket.close(Number.isInteger(code) && code >= 4000 && code <= 4999 ? code : 1000);
    this.broadcast(socket);
  }

  webSocketError(socket) {
    if (socket.readyState !== 3) socket.close(1011, 'Connection error');
    this.broadcast(socket);
  }

  broadcast(excluded) {
    const sockets = this.ctx.getWebSockets().filter(socket => socket !== excluded && socket.readyState === 1);
    const players = sockets.map(socket => {
      const { id, x, y } = socket.deserializeAttachment();
      return { id, x, y };
    });
    const message = JSON.stringify({ players });
    for (const socket of sockets) {
      try { socket.send(message); } catch { /* disconnected during broadcast */ }
    }
  }
}
