import { getSandbox, Sandbox } from '@cloudflare/sandbox';

export { Sandbox };

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  Room: DurableObjectNamespace;
}

interface UserInfo {
  id: string;
  name: string;
  color: string;
}

function generateRandomNameSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const num = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  const str = Math.abs(num).toString(36);
  return str.slice(0, 4).padEnd(4, '0');
}

// High-contrast, tech-focused color palette for user cursors/avatars
function randomColor(): string {
  const colors = [
    '#10b981', // Emerald
    '#06b6d4', // Cyan
    '#3b82f6', // Blue
    '#8b5cf6', // Violet
    '#d946ef', // Fuchsia
    '#f43f5e', // Rose
    '#eab308', // Yellow
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

interface ClientConnection {
  ws: WebSocket;
  info: UserInfo;
}

export class Room implements DurableObject {
  private clients: Map<string, ClientConnection> = new Map();
  private ptyId: string | null = null;
  private outputBuffer: string[] = [];
  private containerWs: WebSocket | null = null;
  private roomId: string = '';
  private env: Env;

  constructor(_ctx: DurableObjectState, env: Env) {
    this.env = env;
  }

  private getConnectedUsers(): UserInfo[] {
    return Array.from(this.clients.values()).map((c) => c.info);
  }

  private broadcast(message: object, excludeUserId?: string): void {
    const data = JSON.stringify(message);
    for (const [userId, client] of this.clients) {
      if (userId !== excludeUserId) {
        try {
          client.ws.send(data);
        } catch {
          // Stale connection
        }
      }
    }
  }

  private async startPty(ws: WebSocket, cols: number, rows: number): Promise<void> {
    if (this.ptyId) {
      ws.send(JSON.stringify({ type: 'pty_started', ptyId: this.ptyId }));
      return;
    }

    try {
      const sandbox = getSandbox(this.env.Sandbox, `shared-sandbox`);

      // SOC-optimized prompt (Root @ Green Host)
      const PS1 = '\\[\\e[38;5;196m\\]root\\[\\e[0m\\]@\\[\\e[38;5;46m\\]sec-ops\\[\\e[0m\\] \\[\\e[38;5;51m\\]\\w\\[\\e[0m\\] \\[\\e[38;5;196m\\]#\\[\\e[0m\\] ';

      const ptyResponse = await sandbox.fetch(
        new Request('http://container/api/pty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cols: cols || 80,
            rows: rows || 24,
            command: ['/bin/bash', '--norc', '--noprofile'],
            cwd: '/home/sec-admin',
            env: {
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
              LANG: 'en_US.UTF-8',
              HOME: '/home/sec-admin',
              USER: 'root',
              PS1,
              ROOM_ID: this.roomId,
              HISTFILE: '/dev/null', // Security: prevent persistent history
              CLICOLOR: '1',
              CLICOLOR_FORCE: '1',
              FORCE_COLOR: '3'
            }
          })
        })
      );

      if (!ptyResponse.ok) throw new Error(`Failed to create PTY: ${await ptyResponse.text()}`);

      const ptyResult = (await ptyResponse.json()) as { success: boolean; pty: { id: string } };
      this.ptyId = ptyResult.pty.id;

      const wsRequest = new Request('http://container/ws', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' }
      });
      const wsResponse = await sandbox.fetch(wsRequest);

      if (!wsResponse.webSocket) throw new Error('WebSocket connection failed');
      
      this.containerWs = wsResponse.webSocket;
      this.containerWs.accept();

      this.containerWs.addEventListener('message', (wsEvent) => {
        try {
          const containerMsg = JSON.parse(wsEvent.data as string);
          if (containerMsg.type === 'stream' && containerMsg.data) {
            const streamData = JSON.parse(containerMsg.data);
            if (streamData.type === 'pty_data' && streamData.data) {
              this.outputBuffer.push(streamData.data);
              if (this.outputBuffer.length > 1000) this.outputBuffer.shift();
              this.broadcast({ type: 'pty_output', data: streamData.data });
            } else if (streamData.type === 'pty_exit') {
              this.broadcast({ type: 'pty_exit', exitCode: streamData.exitCode });
              this.ptyId = null;
              this.containerWs?.close();
              this.containerWs = null;
            }
          }
        } catch (e) {
          console.error('Parse error:', e);
        }
      });

      this.containerWs.addEventListener('close', () => { this.containerWs = null; });

      this.containerWs.send(
        JSON.stringify({
          type: 'request',
          id: `pty_stream_${this.ptyId}`,
          method: 'GET',
          path: `/api/pty/${this.ptyId}/stream`,
          headers: { Accept: 'text/event-stream' }
        })
      );

      this.broadcast({ type: 'pty_started', ptyId: this.ptyId });
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'PTY Error' }));
    }
  }

  private handleClientMessage(userId: string, ws: WebSocket, data: string): void {
    const client = this.clients.get(userId);
    if (!client) return;

    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'start_pty':
          this.startPty(ws, msg.cols || 80, msg.rows || 24);
          break;
        case 'pty_input':
          if (this.ptyId && this.containerWs && msg.data) {
            this.containerWs.send(JSON.stringify({ type: 'pty_input', ptyId: this.ptyId, data: msg.data }));
            this.broadcast({ type: 'user_typing', user: client.info }, userId);
          }
          break;
        case 'pty_resize':
          if (this.ptyId && this.containerWs && msg.cols && msg.rows) {
            this.containerWs.send(JSON.stringify({ type: 'pty_resize', ptyId: this.ptyId, cols: msg.cols, rows: msg.rows }));
          }
          break;
      }
    } catch (error) {
      console.error('Message error:', error);
    }
  }

  private handleClientDisconnect(userId: string): void {
    this.clients.delete(userId);
    this.broadcast({ type: 'user_left', userId, users: this.getConnectedUsers() });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const userName = url.searchParams.get('name') || `Analyst-${generateRandomNameSuffix()}`;
      this.roomId = url.searchParams.get('roomId') || 'default';

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const userId = crypto.randomUUID();
      const userInfo: UserInfo = { id: userId, name: userName, color: randomColor() };

      this.clients.set(userId, { ws: server, info: userInfo });

      server.addEventListener('message', (e) => this.handleClientMessage(userId, server, e.data as string));
      server.addEventListener('close', () => this.handleClientDisconnect(userId));
      server.addEventListener('error', () => this.handleClientDisconnect(userId));

      server.send(JSON.stringify({
        type: 'connected',
        userId, userName: userInfo.name, userColor: userInfo.color,
        users: this.getConnectedUsers(),
        hasActivePty: this.ptyId !== null,
        history: this.outputBuffer.join('')
      }));

      this.broadcast({ type: 'user_joined', user: userInfo, users: this.getConnectedUsers() }, userId);

      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/room' && request.method === 'POST') {
      return Response.json({
        roomId: crypto.randomUUID().slice(0, 8),
        joinUrl: `${url.origin}?room=`
      });
    }

    if (url.pathname.startsWith('/ws/room/')) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Upgrade required', { status: 426 });

      const roomId = url.pathname.split('/')[3];
      const id = env.Room.idFromName(`room-${roomId}`);
      const room = env.Room.get(id);

      const wsUrl = new URL(request.url);
      wsUrl.searchParams.set('roomId', roomId);
      return room.fetch(new Request(wsUrl.toString(), request));
    }
    return new Response('Not found', { status: 404 });
  }
};
