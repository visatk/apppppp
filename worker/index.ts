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

function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Math.abs((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3])
    .toString(36).slice(0, 4).padEnd(4, '0').toUpperCase();
}

function randomColor(): string {
  const colors = ['#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e', '#eab308'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Room DO now strictly handles Collaboration Presence (who is here, who is typing)
export class Room implements DurableObject {
  private clients: Map<string, { ws: WebSocket; info: UserInfo }> = new Map();
  private hasActivePty: boolean = false;

  // FIX: Removed 'private' modifier to comply with 'erasableSyntaxOnly'
  // Prefixed with '_' to ignore unused variable warning
  constructor(_ctx: DurableObjectState, _env: Env) {}

  private broadcast(message: object, excludeUserId?: string): void {
    const data = JSON.stringify(message);
    for (const [id, client] of this.clients) {
      if (id !== excludeUserId) {
        try { client.ws.send(data); } catch { /* ignore stale connection */ }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Upgrade required', { status: 426 });

    const url = new URL(request.url);
    const userName = url.searchParams.get('name') || `OP-${generateId()}`;
    const userId = crypto.randomUUID();
    const userInfo: UserInfo = { id: userId, name: userName, color: randomColor() };

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    this.clients.set(userId, { ws: server, info: userInfo });

    server.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type === 'start_pty') {
          this.hasActivePty = true;
          this.broadcast({ type: 'pty_started' });
        } else if (msg.type === 'user_typing') {
          this.broadcast({ type: 'user_typing', user: userInfo }, userId);
        }
      } catch (err) { console.error(err); }
    });

    server.addEventListener('close', () => {
      this.clients.delete(userId);
      this.broadcast({ type: 'user_left', userId, users: Array.from(this.clients.values()).map(c => c.info) });
    });

    server.send(JSON.stringify({
      type: 'connected',
      userId,
      users: Array.from(this.clients.values()).map(c => c.info),
      hasActivePty: this.hasActivePty
    }));

    this.broadcast({ type: 'user_joined', users: Array.from(this.clients.values()).map(c => c.info) }, userId);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/room' && request.method === 'POST') {
      return Response.json({ roomId: crypto.randomUUID().slice(0, 8) });
    }

    if (url.pathname === '/ws/terminal') {
      const roomId = url.searchParams.get('room');
      if (!roomId) return new Response('Missing room ID', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WS', { status: 426 });

      const sandbox = getSandbox(env.Sandbox, `sandbox-${roomId}`);
      const PS1 = '\\[\\e[38;5;196m\\]root\\[\\e[0m\\]@\\[\\e[38;5;46m\\]sec-ops\\[\\e[0m\\] \\[\\e[38;5;51m\\]\\w\\[\\e[0m\\] \\[\\e[38;5;196m\\]#\\[\\e[0m\\] ';

      // FIX: Bypass TypeScript type-checking for the missing .terminal() definition in @cloudflare/sandbox
      // @ts-ignore
      return sandbox.terminal(request, {
        command: ['/bin/bash', '--norc', '--noprofile'],
        cwd: '/home/sec-admin',
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: 'en_US.UTF-8',
          HOME: '/home/sec-admin',
          USER: 'root',
          PS1,
          HISTFILE: '/dev/null',
          CLICOLOR: '1',
          CLICOLOR_FORCE: '1',
          FORCE_COLOR: '3'
        }
      });
    }

    if (url.pathname.startsWith('/ws/room/')) {
      const roomId = url.pathname.split('/')[3];
      const id = env.Room.idFromName(`room-${roomId}`);
      return env.Room.get(id).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};
