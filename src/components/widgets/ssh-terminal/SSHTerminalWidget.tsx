'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { getTerminalSessionManager } from '@/lib/terminal-session-manager';

interface SSHTerminalWidgetProps {
  widgetId: string;
  serverId: string;
}

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

function createTerminal(): Terminal {
  return new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 13,
    theme: {
      background: '#0b1020',
      foreground: '#e0e0e0',
      cursor: '#00ff00',
      cursorAccent: '#0b1020',
      selectionBackground: 'rgba(0, 255, 0, 0.3)',
      black: '#000000',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#bfbfbf',
      brightBlack: '#4f4f4f',
      brightRed: '#ff6e67',
      brightGreen: '#5af78e',
      brightYellow: '#f4f99c',
      brightBlue: '#caa9fa',
      brightMagenta: '#ff92d0',
      brightCyan: '#9aedfe',
      brightWhite: '#e6e6e6'
    },
    allowProposedApi: true
  });
}

function ensureXtermCss() {
  if (!document.getElementById('xterm-css')) {
    const link = document.createElement('link');
    link.id = 'xterm-css';
    link.rel = 'stylesheet';
    link.href = '/xterm.css';
    document.head.appendChild(link);
  }
}

export function SSHTerminalWidget({ widgetId, serverId }: SSHTerminalWidgetProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const statusRef = useRef<ConnectionStatus>('idle');
  const detachedRef = useRef(false); // true when terminal disposed but WS kept alive
  const passwordRef = useRef('');

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState<string>(() =>
    localStorage.getItem(`bosun-terminal-user-${serverId}`) || ''
  );
  const [password, setPassword] = useState<string>('');
  const sessionId = widgetId; // Deterministic based on widgetId

  useEffect(() => { passwordRef.current = password; }, [password]);

  // Save username to localStorage when changed (the password is never stored)
  const handleUsernameChange = (value: string) => {
    setUsername(value);
    if (value) {
      localStorage.setItem(`bosun-terminal-user-${serverId}`, value);
    }
  };

  // Derive WebSocket URL from current page origin (works with Cloudflare)
  const getWsUrl = () => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws/terminal`;
  };

  // keepAlive: if true, keep the WebSocket session on the server but release
  // the local terminal (used when the widget unmounts on a dashboard switch).
  const cleanup = useCallback((keepAlive = false) => {
    const tsm = getTerminalSessionManager();

    if (keepAlive) {
      detachedRef.current = true;
      tsm.detachFromSession(widgetId);
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      fitAddonRef.current = null;
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      tsm.setSessionStatus(widgetId, 'disconnected');
      return;
    }

    // Full destroy - close WebSocket and clean up completely
    tsm.destroySession(widgetId);

    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    fitAddonRef.current = null;
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    detachedRef.current = false;
  }, [widgetId]);

  const connect = useCallback(async (targetUsername?: string, targetPassword?: string) => {
    const userToUse = (targetUsername ?? username).trim();
    const passToUse = targetPassword ?? passwordRef.current;

    if (!userToUse) {
      setError('Username required');
      return;
    }
    if (!passToUse) {
      setError('Password required');
      return;
    }

    // Prevent multiple concurrent connections
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (statusRef.current === 'connecting') return;

    // Close any orphaned WebSocket from a previous session
    const tsm = getTerminalSessionManager();
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    const existingSession = tsm.getSession(widgetId);
    if (existingSession?.ws && existingSession.ws.readyState === WebSocket.OPEN) {
      existingSession.ws.close();
      tsm.setSessionWebSocket(widgetId, null);
    }

    console.log('[WS] Connecting to:', getWsUrl(), 'serverId:', serverId, 'user:', userToUse);

    // Clean slate - destroy previous terminal + ws
    cleanup();
    ensureXtermCss();

    const term = createTerminal();
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current!);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    tsm.setSessionTerminal(widgetId, term);

    const handleResize = () => {
      if (!fitAddonRef.current) return;
      try { fitAddonRef.current.fit(); } catch {}
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'resize',
          cols: termRef.current?.cols,
          rows: termRef.current?.rows
        }));
      }
    };
    resizeObserverRef.current = new ResizeObserver(handleResize);
    if (terminalRef.current?.parentElement) {
      resizeObserverRef.current.observe(terminalRef.current.parentElement);
    }

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    setStatus('connecting');
    statusRef.current = 'connecting';
    setError(null);

    try {
      // Get a short-lived WebSocket token
      const tokenRes = await fetchWithAuth('/api/ws-token', { method: 'POST' });
      const tokenJson = await tokenRes.json();

      if (!tokenJson.data?.token) {
        throw new Error(tokenJson.error?.message || 'Failed to get WebSocket token');
      }

      const url = new URL(getWsUrl());
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('serverId', serverId);
      url.searchParams.set('token', tokenJson.data.token);
      // Username is needed to match reattached sessions; the password is sent
      // as the first WebSocket frame so it never lands in URLs or access logs.
      url.searchParams.set('sshUser', userToUse);

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      tsm.registerSession(widgetId, serverId, userToUse);
      tsm.setSessionWebSocket(widgetId, ws);
      tsm.setSessionStatus(widgetId, 'connecting');

      ws.onopen = () => {
        console.log('[WS] Connected, authenticating as', userToUse);
        // Credentials frame for this connection only - never persisted.
        ws.send(JSON.stringify({ type: 'auth', password: passToUse }));
        // Send initial terminal dimensions
        setTimeout(() => {
          if (termRef.current && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'resize',
              cols: termRef.current.cols,
              rows: termRef.current.rows
            }));
          }
        }, 200);
      };

      ws.onmessage = (event) => {
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);

        // If detached (terminal disposed but WS kept alive), only buffer data
        if (detachedRef.current) {
          tsm.appendToBuffer(widgetId, data);
          return;
        }

        // The server sends this before closing when SSH auth/shell setup fails.
        const failure = data.match(/\*\*\* SSH (?:connection|shell) failed: (.*?) \*\*\*/);
        if (failure) {
          setError(failure[1] || 'Connection failed');
          setStatus('error');
          statusRef.current = 'error';
          tsm.setSessionStatus(widgetId, 'error');
          if (termRef.current) termRef.current.write(data);
          return;
        }

        // First output means the SSH session is up (auth happens during the
        // WebSocket handshake), so flip to connected and re-fit.
        if (statusRef.current !== 'connected') {
          setStatus('connected');
          statusRef.current = 'connected';
          tsm.setSessionStatus(widgetId, 'connected');
          setTimeout(() => {
            if (fitAddonRef.current && termRef.current) {
              try { fitAddonRef.current.fit(); } catch {}
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                  type: 'resize',
                  cols: termRef.current.cols,
                  rows: termRef.current.rows
                }));
              }
            }
          }, 100);
        }

        if (termRef.current) {
          termRef.current.write(data);
          tsm.appendToBuffer(widgetId, data);
        }
      };

      ws.onclose = (event) => {
        console.log('[WS] Disconnected:', event.code, event.reason);
        // A close while still connecting means the SSH login failed; surface
        // the reason (ssh2 puts e.g. "All configured authentication methods
        // failed" here). Otherwise it's an ordinary session end.
        if (statusRef.current === 'connecting') {
          setError(event.reason || 'Connection failed');
          setStatus('error');
          statusRef.current = 'error';
          tsm.setSessionStatus(widgetId, 'error');
        } else if (statusRef.current === 'connected') {
          setStatus('disconnected');
          statusRef.current = 'disconnected';
          tsm.setSessionStatus(widgetId, 'disconnected');
        }
      };

      ws.onerror = () => {
        console.error('[WS] WebSocket error');
      };

    } catch (err: any) {
      console.error('[WS] Connection error:', err);
      setError(err.message || 'Failed to connect');
      setStatus('error');
      statusRef.current = 'error';
    }
  }, [username, sessionId, serverId, cleanup, widgetId]);

  // Disconnect from WebSocket server - FULL destroy (user clicked disconnect)
  const disconnect = useCallback(() => {
    cleanup(false);
    setStatus('idle');
    statusRef.current = 'idle';
  }, [cleanup]);

  // Cleanup on unmount - detach but KEEP session alive on server so it persists
  // across dashboard switches.
  useEffect(() => {
    ensureXtermCss();
    return () => {
      cleanup(true);
    };
  }, [cleanup]);

  // Reattach to a live session after a dashboard switch.
  useEffect(() => {
    const tsm = getTerminalSessionManager();
    const existingSession = tsm.getSession(widgetId);

    if (existingSession?.ws && existingSession.ws.readyState === WebSocket.OPEN) {
      // A session that was still handshaking can never finish now that its
      // owning component unmounted, and the password isn't retained, so drop it
      // and let the user reconnect rather than fake a connected state.
      if (existingSession.status === 'connecting') {
        cleanup(false);
        return;
      }

      console.log('[TSM] Found existing session, reattaching:', widgetId);
      ensureXtermCss();

      const term = createTerminal();
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current!);
      fitAddon.fit();

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Replay scrollback buffer
      for (const chunk of tsm.getBuffer(widgetId)) {
        term.write(chunk);
      }

      const ws = existingSession.ws;
      detachedRef.current = false;
      wsRef.current = ws;

      setStatus('connected');
      statusRef.current = 'connected';
      tsm.setSessionStatus(widgetId, 'connected');
      tsm.setSessionTerminal(widgetId, term);

      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });

      const handleResize = () => {
        if (!fitAddonRef.current) return;
        try { fitAddonRef.current.fit(); } catch {}
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: termRef.current?.cols,
            rows: termRef.current?.rows
          }));
        }
      };
      resizeObserverRef.current = new ResizeObserver(handleResize);
      if (terminalRef.current?.parentElement) {
        resizeObserverRef.current.observe(terminalRef.current.parentElement);
      }

      // Re-wire handlers to THIS component's refs (React creates new refs on
      // every mount, so the old closures point at dead refs).
      ws.onmessage = (event) => {
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        if (detachedRef.current) {
          tsm.appendToBuffer(widgetId, data);
          return;
        }
        if (termRef.current) termRef.current.write(data);
        tsm.appendToBuffer(widgetId, data);
      };
      ws.onclose = () => {
        setStatus('disconnected');
        statusRef.current = 'disconnected';
        tsm.setSessionStatus(widgetId, 'disconnected');
      };
      ws.onerror = () => {
        setStatus('error');
        statusRef.current = 'error';
        tsm.setSessionStatus(widgetId, 'error');
      };

      tsm.setSessionWebSocket(widgetId, ws);
      console.log('[TSM] Reattached to session:', widgetId);
      return;
    }

    // No auto-connect when no existing session - let the user sign in.
  }, [cleanup, widgetId]);

  const handleConnect = () => {
    if (status === 'idle' || status === 'disconnected' || status === 'error') {
      if (username) {
        connect(username, password);
      }
    }
  };

  const handleDisconnect = () => {
    disconnect();
  };

  const handleReconnect = () => {
    if (username) {
      connect(username, password);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Terminal container */}
      <div className="flex-1 relative">
        <div
          ref={terminalRef}
          className="absolute inset-0"
          style={{ minHeight: '150px' }}
        />

        {/* Idle state - login form */}
        {status === 'idle' && (
          <div className="absolute inset-0 bg-gray-900/90 flex items-center justify-center p-4">
            <div className="text-center w-full max-w-xs">
              <p className="text-gray-300 text-sm mb-4">Sign in to this server</p>
              <input
                type="text"
                value={username}
                onChange={(e) => handleUsernameChange(e.target.value)}
                placeholder="Username"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-gray-200 text-sm mb-3"
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-gray-200 text-sm mb-3"
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              />
              <button
                onClick={handleConnect}
                disabled={!username || !password}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded disabled:opacity-50 disabled:cursor-not-allowed w-full"
              >
                Connect
              </button>
            </div>
          </div>
        )}

        {/* Error overlay */}
        {error && status !== 'idle' && (
          <div className="absolute inset-0 bg-red-900/80 flex items-center justify-center p-4">
            <div className="text-center">
              <p className="text-red-200 text-sm mb-2">Connection Error</p>
              <p className="text-red-100 text-xs mb-3">{error}</p>
              <button
                onClick={handleReconnect}
                className="px-3 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Connecting overlay */}
        {status === 'connecting' && (
          <div className="absolute inset-0 bg-gray-900/80 flex items-center justify-center">
            <p className="text-gray-300 text-sm">Connecting...</p>
          </div>
        )}
      </div>

      {/* Control bar */}
      <div className="flex items-center justify-between px-2 py-1 bg-gray-900 border-t border-gray-700">
        {/* Status indicator */}
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              status === 'connected'
                ? 'bg-green-500'
                : status === 'connecting'
                ? 'bg-yellow-500 animate-pulse'
                : status === 'error'
                ? 'bg-red-500'
                : status === 'idle'
                ? 'bg-blue-500'
                : 'bg-gray-500'
            }`}
          />
          <span className="text-xs text-gray-400">
            {status === 'connected'
              ? 'Connected'
              : status === 'connecting'
              ? 'Connecting...'
              : status === 'error'
              ? 'Error'
              : status === 'idle'
              ? 'Idle'
              : 'Disconnected'}
          </span>
        </div>

        {/* Control buttons */}
        <div className="flex gap-2">
          {status === 'connected' ? (
            <button
              onClick={handleDisconnect}
              className="px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
            >
              Disconnect
            </button>
          ) : status !== 'idle' && (
            <button
              onClick={handleReconnect}
              disabled={status === 'connecting'}
              className="px-2 py-0.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded disabled:opacity-50"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
