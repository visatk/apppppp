import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { SandboxAddon } from '@cloudflare/sandbox/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';

const terminalTheme = {
  background: '#020617', foreground: '#10b981', cursor: '#10b981', cursorAccent: '#020617',
  selectionBackground: '#064e3b80', selectionForeground: '#ffffff', selectionInactiveBackground: '#064e3b40',
  black: '#020617', red: '#ef4444', green: '#10b981', yellow: '#eab308', blue: '#3b82f6',
  magenta: '#d946ef', cyan: '#06b6d4', white: '#f8fafc', brightBlack: '#475569',
  brightRed: '#f87171', brightGreen: '#34d399', brightYellow: '#fde047',
  brightBlue: '#60a5fa', brightMagenta: '#e879f9', brightCyan: '#22d3ee', brightWhite: '#ffffff'
};

interface User { id: string; name: string; color: string; }
interface AppState {
  connected: boolean; roomId: string | null; userId: string | null;
  users: User[]; hasActivePty: boolean; typingUser: User | null; isBooting: boolean;
}

function generateId(): string {
  const array = new Uint32Array(1);
  window.crypto.getRandomValues(array);
  return array[0].toString(36).slice(0, 4).toUpperCase();
}

export function App() {
  const [state, setState] = useState<AppState>({
    connected: false, roomId: null, userId: null, users: [], hasActivePty: false, typingUser: null, isBooting: false
  });

  const [joinName, setJoinName] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [copied, setCopied] = useState(false);

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const addonRef = useRef<SandboxAddon | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSyncRef = useRef<number>(0);

  const connectToRoom = useCallback((roomId: string, userName: string) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/room/${roomId}?name=${encodeURIComponent(userName)}`);

    ws.addEventListener('open', () => {
      wsRef.current = ws;
      setState(s => ({ ...s, roomId }));
      window.history.replaceState({}, '', `?room=${roomId}`);
    });

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      switch (message.type) {
        case 'connected':
          setState(s => ({ ...s, connected: true, userId: message.userId, users: message.users, hasActivePty: message.hasActivePty }));
          break;
        case 'user_joined':
        case 'user_left':
          setState(s => ({ ...s, users: message.users }));
          break;
        case 'pty_started':
          setState(s => ({ ...s, hasActivePty: true, isBooting: false }));
          break;
        case 'pty_exited':
          setState(s => ({ ...s, hasActivePty: false, isBooting: false }));
          break;
        case 'user_typing':
          setState(s => ({ ...s, typingUser: message.user }));
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = setTimeout(() => setState(s => ({ ...s, typingUser: null })), 1000);
          break;
      }
    });

    ws.addEventListener('close', () => {
      wsRef.current = null;
      setState(s => ({ ...s, connected: false, roomId: null, users: [], hasActivePty: false }));
    });
  }, []);

  useEffect(() => {
    if (!state.connected || !terminalRef.current || xtermRef.current || !state.roomId) return;

    const term = new Terminal({
      cursorBlink: true, cursorStyle: 'block', cursorWidth: 2, theme: terminalTheme,
      fontSize: 14, fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      lineHeight: 1.4, scrollback: 50000, convertEol: true
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    const sandboxAddon = new SandboxAddon({
      getWebSocketUrl: ({ origin }) => {
        const wsOrigin = origin.replace(/^http/, 'ws');
        return `${wsOrigin}/ws/terminal?room=${state.roomId}`;
      },
      onStateChange: (terminalState, error) => {
        // BUG FIX: Auto-Recovery on Disconnect
        if (terminalState === 'disconnected') {
          term.writeln(`\r\n\x1b[31m[Session Drop: ${error?.message || 'Connection closed by remote host'}]\x1b[0m`);
          setState(s => ({ ...s, hasActivePty: false, isBooting: false }));
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'pty_exited' }));
          }
        }
      }
    });

    term.loadAddon(sandboxAddon);
    term.open(terminalRef.current);
    setTimeout(() => fitAddon.fit(), 0);
    xtermRef.current = term;
    addonRef.current = sandboxAddon;

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    if (state.hasActivePty) sandboxAddon.connect({ sandboxId: state.roomId });

    return () => {
      window.removeEventListener('resize', handleResize);
      sandboxAddon.disconnect();
      term.dispose();
      xtermRef.current = null;
      addonRef.current = null;
    };
  }, [state.connected, state.roomId]);

  useEffect(() => {
    if (state.hasActivePty && addonRef.current && state.roomId && !state.isBooting) {
      addonRef.current.connect({ sandboxId: state.roomId });
    }
  }, [state.hasActivePty, state.roomId, state.isBooting]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    
    // PERFORMANCE FIX: Throttle typing broadcasts to 1 per second max
    const disposable = term.onData(() => {
      const now = Date.now();
      if (wsRef.current?.readyState === WebSocket.OPEN && state.hasActivePty && (now - lastTypingSyncRef.current > 1000)) {
        wsRef.current.send(JSON.stringify({ type: 'user_typing' }));
        lastTypingSyncRef.current = now;
      }
    });
    return () => disposable.dispose();
  }, [state.hasActivePty]);

  const startPty = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setState(s => ({ ...s, isBooting: true }));
      wsRef.current.send(JSON.stringify({ type: 'start_pty' }));
    }
  }, []);

  const createRoom = async () => {
    const name = joinName.trim() || `OP-${generateId()}`;
    const response = await fetch('/api/room', { method: 'POST' });
    const data = await response.json();
    connectToRoom(data.roomId, name);
  };

  const copyRoomLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}?room=${state.roomId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    const roomFromUrl = new URLSearchParams(window.location.search).get('room');
    if (roomFromUrl) setJoinRoomId(roomFromUrl);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans relative overflow-hidden flex flex-col selection:bg-emerald-500/30">
      <div className="fixed inset-0 pointer-events-none bg-[image:linear-gradient(rgba(16,185,129,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(16,185,129,0.03)_1px,transparent_1px)] bg-[size:40px_40px] opacity-70 animate-[pulse_10s_ease-in-out_infinite]" />
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(16,185,129,0.1),transparent)]" />

      {!state.connected ? (
        <main className="flex-1 flex flex-col relative z-10">
          <header className="p-6 md:px-8 border-b border-emerald-900/30 bg-slate-950/50 backdrop-blur">
            <div className="flex items-center gap-3 font-mono font-bold text-lg text-emerald-500 tracking-widest uppercase">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span>SOC Command Center</span>
            </div>
          </header>

          <section className="flex-1 flex flex-col items-center justify-center px-6 pb-20 text-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-xs font-mono text-emerald-400 mb-8 uppercase tracking-widest">
              <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_#10b981]" />
              Secure Sandbox Environment
            </div>
            
            <h1 className="text-4xl md:text-[64px] font-bold tracking-tight mb-4 text-slate-100">
              Tactical Analysis <br />
              <span className="text-emerald-500 drop-shadow-[0_0_20px_rgba(16,185,129,0.2)]">Terminal</span>
            </h1>
            
            <p className="text-base text-slate-400 max-w-[500px] mb-12">
              Encrypted, collaborative session for real-time threat monitoring, vulnerability assessment, and zero-day investigations.
            </p>

            <div className="bg-slate-900/80 border border-emerald-900/50 rounded-lg p-8 w-full max-w-md backdrop-blur-xl shadow-2xl">
              <div className="mb-6 text-left">
                <label className="block text-xs font-mono text-emerald-500/80 mb-2 uppercase tracking-widest">Operator ID</label>
                <input
                  type="text"
                  placeholder={`OP-${generateId()}`}
                  value={joinName}
                  onChange={(e) => setJoinName(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded font-mono text-emerald-400 placeholder:text-slate-700 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all"
                />
              </div>

              <button onClick={createRoom} className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 text-slate-950 rounded font-bold font-mono uppercase tracking-widest transition-colors mb-6">
                Initialize Secure Room
              </button>

              <div className="flex gap-3">
                <input
                  type="text"
                  placeholder="Existing Room ID"
                  value={joinRoomId}
                  onChange={(e) => setJoinRoomId(e.target.value)}
                  className="flex-1 px-4 py-3 bg-slate-950 border border-slate-800 rounded font-mono text-emerald-400 placeholder:text-slate-700 focus:outline-none focus:border-slate-600 transition-all uppercase"
                />
                <button
                  onClick={() => connectToRoom(joinRoomId, joinName.trim() || `OP-${generateId()}`)}
                  disabled={!joinRoomId.trim()}
                  className="px-6 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded font-bold font-mono uppercase transition-all disabled:opacity-50"
                >
                  Join
                </button>
              </div>
            </div>
          </section>
        </main>
      ) : (
        <main className="flex-1 flex flex-col relative z-10">
          <header className="flex items-center justify-between px-6 py-3 bg-slate-950 border-b border-emerald-900/50 gap-4">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2 text-emerald-500">
                {/* Lock icon representing security */}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono text-slate-500 uppercase tracking-widest">Active Relay</span>
                <code className="px-2 py-1 bg-slate-900 border border-slate-800 rounded font-mono text-sm text-emerald-400">{state.roomId}</code>
                <button onClick={copyRoomLink} className="text-slate-500 hover:text-emerald-400 transition-colors">
                  {copied ? <span className="text-xs font-mono uppercase text-emerald-400">Copied</span> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex -space-x-2">
                {state.users.map((u) => (
                  <div key={u.id} className="w-8 h-8 rounded border-2 border-slate-950 flex items-center justify-center text-xs font-bold font-mono shadow-sm" style={{ backgroundColor: u.color, color: '#020617' }} title={u.name}>
                    {u.name.slice(0, 2).toUpperCase()}
                  </div>
                ))}
              </div>
            </div>
          </header>

          <section className="flex-1 p-4 md:p-6 flex justify-center items-start">
            <div className="w-full max-w-[1600px] h-full max-h-[85vh] flex flex-col bg-slate-950 border border-emerald-900/40 rounded-lg overflow-hidden shadow-[0_0_40px_rgba(16,185,129,0.08)]">
              
              <div className="flex items-center px-4 py-2 bg-slate-900 border-b border-emerald-900/40">
                <div className="flex-1 text-xs text-emerald-500/70 font-mono tracking-widest uppercase flex items-center gap-4">
                  <span>{state.hasActivePty ? 'STATUS: ENCRYPTED_STREAM_ACTIVE' : 'STATUS: AWAITING_BOOT'}</span>
                  {state.typingUser && <span className="text-emerald-400">[{state.typingUser.name} is typing...]</span>}
                </div>
                {!state.hasActivePty && (
                  <button onClick={startPty} disabled={state.isBooting} className="px-4 py-1.5 bg-emerald-900/50 hover:bg-emerald-800/50 text-emerald-400 border border-emerald-800 rounded text-xs font-mono uppercase transition-colors disabled:opacity-50 flex items-center gap-2">
                    {state.isBooting ? <><span className="w-3 h-3 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /> BOOTING...</> : 'Execute Boot Sequence'}
                  </button>
                )}
              </div>

              {/* UX FIX: Clicking anywhere in this background focuses the terminal */}
              <div className="flex-1 relative bg-[#020617] cursor-text" onClick={() => xtermRef.current?.focus()}>
                <div ref={terminalRef} className={`absolute inset-0 p-4 transition-opacity duration-300 ${!state.hasActivePty ? 'opacity-0' : 'opacity-100'}`} />
                
                {!state.hasActivePty && (
                  <div className="absolute inset-0 flex items-center justify-center font-mono text-slate-500 text-sm pointer-events-none">
                    {state.isBooting ? 'INITIALIZING CONTAINERS...' : 'SYSTEM IDLE. INITIATE BOOT SEQUENCE TO MOUNT FILE SYSTEM.'}
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}
