import { DurableObject } from 'cloudflare:workers';

const abilityIds = ['corn', 'cucumber', 'juice', 'brainfreeze'];
const roomCodes = ['bajs', 'kiss', 'prutt', 'fis', 'rumpa'];

const origins = new Set([
  'https://www.burgerblox.se',
  'https://burgerblox.se',
  'https://birgerkling.github.io',
]);

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/party-health') return new Response('Garden Defence party v1 · equal party controls');
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
    server.send(JSON.stringify({ self: server.deserializeAttachment().id, parties: true, partyWallets: true, equalParty: true }));
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > 250000) return;
    const player = socket.deserializeAttachment();
    let position;
    try { position = JSON.parse(message); } catch { return; }
    if (position?.op) return this.partyMessage(socket, player, position);
    const now = Date.now();
    if (now - player.updated < 200) return;
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
    player.x = Math.max(25, Math.min(975, position.x));
    player.y = Math.max(45, Math.min(565, position.y));
    player.updated = now;
    socket.serializeAttachment(player);
    this.broadcast();
  }

  webSocketClose(socket, code) {
    if (socket.readyState !== 3) socket.close(Number.isInteger(code) && code >= 4000 && code <= 4999 ? code : 1000);
    this.partyDisconnected(socket);
    this.broadcast(socket);
  }

  webSocketError(socket) {
    if (socket.readyState !== 3) socket.close(1011, 'Connection error');
    this.partyDisconnected(socket);
    this.broadcast(socket);
  }

  members(room, excluded) {
    return this.ctx.getWebSockets().filter(socket =>
      socket !== excluded && socket.readyState === 1 && socket.deserializeAttachment()?.room === room)
      .sort((a, b) => a.deserializeAttachment().seat - b.deserializeAttachment().seat);
  }

  send(socket, data) {
    try { socket.send(JSON.stringify(data)); } catch { /* connection closed */ }
  }

  roster(room) {
    const members = this.members(room);
    const ids = members.map(socket => socket.deserializeAttachment().id);
    for (const socket of members) this.send(socket, { party: { room, ids, host: ids[0] } });
  }

  partyDisconnected(socket) {
    const player = socket.deserializeAttachment();
    if (!player?.room) return;
    if (player.match) {
      for (const member of this.members(player.room, socket)) {
        const peer = member.deserializeAttachment();
        delete peer.match;
        delete peer.room;
        member.serializeAttachment(peer);
        this.send(member, { partyEnd: 'A player disconnected.' });
      }
    } else {
      const members = this.members(player.room, socket);
      const ids = members.map(member => member.deserializeAttachment().id);
      for (const member of members) this.send(member, { party: { room: player.room, ids, host: ids[0] } });
    }
  }

  partyMessage(socket, player, command) {
    const { op } = command;
    const members = player.room ? this.members(player.room) : [];
    if (op === 'create' || op === 'join') {
      if (player.room) return;
      let room;
      if (op === 'create') {
        const available = roomCodes.filter(code => !this.members(code).length);
        if (!available.length) return this.send(socket, { partyError: 'All five Party rooms are in use. Try again later.' });
        room = available[Math.floor(Math.random() * available.length)];
      } else {
        if (typeof command.room !== 'string') return;
        const code = command.room.trim().toLowerCase();
        if (roomCodes.includes(code) && this.members(code).length) room = code;
        else if (/^(?:[a-z]{4}|[a-f0-9]{8})$/.test(code)) room = code.toUpperCase();
        else return this.send(socket, { partyError: 'That room is unavailable.' });
      }
      const peers = this.members(room);
      if (op === 'join' && (!peers.length || peers.length >= 5 || peers.some(peer => peer.deserializeAttachment().match))) {
        return this.send(socket, { partyError: 'That room is unavailable or full.' });
      }
      player.room = room;
      player.seat = Math.max(0, ...peers.map(peer => peer.deserializeAttachment().seat)) + 1;
      socket.serializeAttachment(player);
      this.roster(room);
      this.broadcast();
    } else if (op === 'leave' && player.room) {
      this.partyDisconnected(socket);
      delete player.match;
      delete player.room;
      socket.serializeAttachment(player);
      this.send(socket, { partyEnd: 'You left the party.' });
      this.broadcast();
    } else if (op === 'start' && members.length && !player.match &&
        [10, 20, 30, 40, 50, 100].includes(command.goal)) {
      for (const member of members) {
        const peer = member.deserializeAttachment();
        peer.match = true;
        member.serializeAttachment(peer);
        this.send(member, { partyStart: { goal: command.goal, count: members.length, host: members[0].deserializeAttachment().id } });
      }
    } else if (op === 'state' && player.match && members[0] === socket) {
      const now = Date.now();
      if (now - (player.lastSnapshot || 0) < 80) return;
      player.lastSnapshot = now;
      socket.serializeAttachment(player);
      for (const member of members.slice(1)) this.send(member, { partyState: command.state });
    } else if (player.match && members[0] !== socket && (op === 'setup' || op === 'action')) {
      const defenderIds = ['bengan','ossy','pelle','skrutt','hannie','albus','kattis'];
      if (op === 'setup') {
        if (!Array.isArray(command.ids) || command.ids.length > 3 ||
            !command.ids.every(id => abilityIds.includes(id)) ||
            !Array.isArray(command.defenders) || !Array.isArray(command.elite)) return;
        const defenders = defenderIds.filter(id => command.defenders.includes(id));
        const elite = defenders.filter(id => command.elite.includes(id));
        this.send(members[0], { partyAction: { kind: 'setup', playerId: player.id,
          ids: [...new Set(command.ids)], defenders, elite } });
      } else {
        const { kind, selected, mode, x, y } = command;
        if (kind !== 'wave' && kind !== 'auto' && kind !== 'click') return;
        if (kind === 'click' && (!Number.isFinite(x) || x < 0 || x > 1000 ||
            !Number.isFinite(y) || y < 0 || y > 650 ||
            (selected !== null && ![...defenderIds,...abilityIds].includes(selected)) ||
            ![null,'move','delete','upgrade'].includes(mode) || (!selected && !mode))) return;
        const now = Date.now();
        if (now - (player.lastAction || 0) < 80) return;
        player.lastAction = now;
        socket.serializeAttachment(player);
        this.send(members[0], { partyAction: { kind, playerId: player.id, selected, mode, x, y } });
      }
    } else if (op === 'place' && player.match && members[0] !== socket &&
        ['bengan', 'ossy', 'pelle', 'skrutt', 'hannie', 'albus', 'kattis'].includes(command.type) &&
        Number.isFinite(command.x) && Number.isFinite(command.y)) {
      const now = Date.now();
      if (now - (player.lastPlace || 0) < 150) return;
      player.lastPlace = now;
      socket.serializeAttachment(player);
      this.send(members[0], { partyPlace: { playerId: player.id, type: command.type, x: command.x, y: command.y } });
    } else if (op === 'finish' && player.match && members[0] === socket) {
      for (const member of members) {
        const peer = member.deserializeAttachment();
        delete peer.match;
        delete peer.room;
        member.serializeAttachment(peer);
        this.send(member, { partyEnd: command.won === true ? 'Party won!' : 'The Garden fell.' });
      }
      this.broadcast();
    }
  }

  broadcast(excluded) {
    const sockets = this.ctx.getWebSockets().filter(socket => socket !== excluded && socket.readyState === 1);
    const players = sockets.filter(socket => !socket.deserializeAttachment().room).map(socket => {
      const { id, x, y } = socket.deserializeAttachment();
      return { id, x, y };
    });
    const message = JSON.stringify({ players });
    for (const socket of sockets) {
      try { socket.send(message); } catch { /* disconnected during broadcast */ }
    }
  }
}
