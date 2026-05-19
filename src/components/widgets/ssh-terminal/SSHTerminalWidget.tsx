'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface SSHTerminalWidgetProps {
  widgetId: string;
  serverId: string;
}

type ConnectionStatus = 'idle' | 'connecting' | 'authenticating' | 'connected' | 'error' | 'disconnected';

export function SSHTerminalWidget({ widgetId, serverId }: SSHTerminalWidgetProps) {
  // Auth refs - use refs inside component (not state) to avoid stale closures in onmessage
  const suSentRef = useRef(false);
  const authenticatedRef = useRef(false);
  const authBufferRef = useRef('');
  const authTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordPromptShownRef = useRef(false);
  const servicePromptRef = useRef<string>('');
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const statusRef = useRef<ConnectionStatus>('idle');

  // Login username ref - accessible inside onmessage closure
  const loginUsernameRef = useRef('');

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState<string>('');
  const [sessionId] = useState(() => Math.random().toString(36).substring(2, 11));

  // Sync username with ref
  useEffect(() => {
    loginUsernameRef.current = username;
  }, [username]);

  // Load persisted username from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(`bosun-terminal-user-${serverId}`);
    if (saved) setUsername(saved);
  }, [serverId]);

  // Save username to localStorage when changed
  const handleUsernameChange = (value: string) => {
    setUsername(value);
    if (value) {
      localStorage.setItem(`bosun-terminal-user-${serverId}`, value);
    }
  };

  // Derive WebSocket URL from current page origin (works with Cloudflare)
  const getWsUrl = () => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.host;
    return `${proto}://${host}/ws/terminal`;
  };

  // Full cleanup - destroys all state for a fresh start
  const cleanup = useCallback(() => {
    // Close WebSocket
    if (wsRef.current) {
      // Null out handlers FIRST to prevent old callbacks from firing
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    // Destroy terminal instance
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    // Clear fit addon ref
    fitAddonRef.current = null;
    // Disconnect resize observer
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    // Clear any pending auth timeouts
    if (authTimeoutRef.current) {
      clearTimeout(authTimeoutRef.current);
      authTimeoutRef.current = null;
    }
    // Reset ALL auth state refs
    suSentRef.current = false;
    authenticatedRef.current = false;
    authBufferRef.current = '';
    passwordPromptShownRef.current = false;
    servicePromptRef.current = '';
  }, []);

  // Connect with authentication flow (su as user)
  const connect = useCallback(async (targetUsername?: string) => {
    const userToUse = (targetUsername || username).trim();
    if (!userToUse) {
      setError('Username required');
      return;
    }

    // Prevent multiple concurrent connections
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }
    if (statusRef.current === 'connecting' || statusRef.current === 'authenticating') {
      return;
    }

    console.log('[WS] Connecting to:', getWsUrl(), 'serverId:', serverId, 'user:', userToUse);

    // 1) Clean slate - destroy previous terminal + ws
    cleanup();

    // 2) Create FRESH Terminal instance
    if (!document.getElementById('xterm-css')) {
      const link = document.createElement('link');
      link.id = 'xterm-css';
      link.rel = 'stylesheet';
      link.href = '/xterm.css';
      document.head.appendChild(link);
    }

    const term = new Terminal({
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

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current!);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // 3) Set up resize observer
    const handleResize = () => {
      if (fitAddonRef.current) {
        try { fitAddonRef.current.fit(); } catch {}
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: termRef.current?.cols,
            rows: termRef.current?.rows
          }));
        }
      }
    };
    resizeObserverRef.current = new ResizeObserver(handleResize);
    if (terminalRef.current?.parentElement) {
      resizeObserverRef.current.observe(terminalRef.current.parentElement);
    }

    // 4) Set up terminal input -> WebSocket (on fresh term instance)
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    setStatus('connecting');
    setError(null);

    // Reset all auth refs
    suSentRef.current = false;
    authenticatedRef.current = false;
    authBufferRef.current = '';
    passwordPromptShownRef.current = false;
    servicePromptRef.current = '';
    loginUsernameRef.current = userToUse;

    try {
      // Get a short-lived WebSocket token
      const tokenRes = await fetchWithAuth('/api/ws-token', { method: 'POST' });
      const tokenJson = await tokenRes.json();

      if (!tokenJson.data?.token) {
        throw new Error(tokenJson.error?.message || 'Failed to get WebSocket token');
      }

      const wsToken = tokenJson.data.token;
      console.log('[WS] Got token, connecting to WebSocket...');

      // Build WebSocket URL using same-host approach
      const wsBase = getWsUrl();
      const url = new URL(wsBase);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('serverId', serverId);
      url.searchParams.set('token', wsToken);

      console.log('[WS] WebSocket URL:', url.toString());

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WS] Connected, will authenticate as', userToUse);
        setStatus('authenticating');
        statusRef.current = 'authenticating';

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

        // Start auth timeout (15 seconds)
        authTimeoutRef.current = setTimeout(() => {
          if (!authenticatedRef.current) {
            console.log('[WS] Auth timeout');
            setError('Authentication timed out');
            ws.close();
            setStatus('error');
            statusRef.current = 'error';
          }
        }, 15000);
      };

      ws.onmessage = (event) => {
        const data = event.data;

        // ========== AUTH PHASE ==========
        if (!authenticatedRef.current) {
          authBufferRef.current += data;

          // Phase 2: Send su after first output (bosun-svc shell ready)
          if (!suSentRef.current) {
            // Capture the service account prompt from initial shell output
            // Matches patterns like: bosun-svc@hostname:~$  or  user@host:/path#
            const promptMatch = authBufferRef.current.match(/\S+@\S+[:#$]\s*$/m);
            if (promptMatch) {
              servicePromptRef.current = promptMatch[0].trim();
              console.log('[WS] Captured service prompt:', servicePromptRef.current);
            }

            setTimeout(() => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(`su - ${userToUse}\r`);
                suSentRef.current = true;
                console.log('[WS] Sent su command for', userToUse);
              }
            }, 500);
            return; // Don't display bosun-svc prompt
          }

          // Phase 3: Detect Password: prompt -> show terminal
          if (!passwordPromptShownRef.current &&
              authBufferRef.current.toLowerCase().includes('password')) {
            passwordPromptShownRef.current = true;
            setStatus('connected');
            statusRef.current = 'connected';
            // Clear the timeout since we got password prompt
            if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
            // Re-fit now that terminal is visible (overlay removed)
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
            // Write clean password prompt to terminal
            if (termRef.current) {
              termRef.current.write('Password: ');
            }
            return;
          }

          // After password prompt shown, pass output to terminal
          if (passwordPromptShownRef.current) {
            // Check for failure
            if (authBufferRef.current.includes('Authentication failure') ||
                authBufferRef.current.includes('su: ') ||
                authBufferRef.current.includes('incorrect password') ||
                authBufferRef.current.includes('does not exist')) {
              if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
              cleanup();
              setError('Login failed - check your username and password');
              setStatus('error');
              statusRef.current = 'error';
              return;
            }

            // Check for success (user's prompt appeared)
            if (data.includes(userToUse + '@') ||
                (authBufferRef.current.includes(userToUse + '@'))) {
              authenticatedRef.current = true;
              if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
              authBufferRef.current = '';
              console.log('[WS] Authentication successful for', userToUse);
              // Re-fit now that terminal is fully visible
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
              // Write this data (it contains the user's prompt)
              if (termRef.current) {
                termRef.current.write(data);
              }
              return;
            }

            // Normal pass-through during password entry
            if (termRef.current) {
              termRef.current.write(data);
            }
          }

          return;
        }

        // ========== NORMAL MODE ==========
        // Check for service account prompt BEFORE writing to terminal
        if (servicePromptRef.current && data.includes(servicePromptRef.current)) {
          console.log('[WS] Detected return to service account, auto-disconnecting');
          cleanup();
          setStatus('idle');
          statusRef.current = 'idle';
          return;
        }

        // Normal terminal output
        if (termRef.current) {
          termRef.current.write(data);
        }
      };

      ws.onclose = (event) => {
        if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
        console.log('[WS] Disconnected:', event.code, event.reason);
        setStatus('idle');
        statusRef.current = 'idle';
      };

      ws.onerror = (event) => {
        if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
        console.error('[WS] Error:', event);
        setError('WebSocket connection error');
        setStatus('error');
        statusRef.current = 'error';
      };

    } catch (err: any) {
      console.error('[WS] Connection error:', err);
      setError(err.message || 'Failed to connect');
      setStatus('error');
      statusRef.current = 'error';
    }
  }, [username, sessionId, serverId, cleanup]); // Removed status from deps

  // Disconnect from WebSocket server
  const disconnect = useCallback(() => {
    cleanup();
    setStatus('idle');
    statusRef.current = 'idle';
  }, [cleanup]);

  // (reconnect removed - now handled by handleReconnect)

  // Initialize terminal (CSS only - terminal created in connect)
  useEffect(() => {
    // Inject xterm CSS once
    if (!document.getElementById('xterm-css')) {
      const link = document.createElement('link');
      link.id = 'xterm-css';
      link.rel = 'stylesheet';
      link.href = '/xterm.css';
      document.head.appendChild(link);
    }

    // Cleanup on unmount
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Handle control buttons
  const handleConnect = () => {
    if (status === 'idle' || status === 'disconnected' || status === 'error') {
      if (username) {
        connect(username);
      }
    }
  };

  const handleDisconnect = () => {
    disconnect();
  };

  const handleReconnect = () => {
    if (username) {
      connect(username);
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
        
        {/* Idle state - username input form */}
        {status === 'idle' && (
          <div className="absolute inset-0 bg-gray-900/90 flex items-center justify-center p-4">
            <div className="text-center w-full max-w-xs">
              <p className="text-gray-300 text-sm mb-4">Enter username to connect as:</p>
              <input
                type="text"
                value={username}
                onChange={(e) => handleUsernameChange(e.target.value)}
                placeholder="Username"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-gray-200 text-sm mb-3"
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              />
              <button
                onClick={handleConnect}
                disabled={!username}
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
        
        {/* Connecting/Authenticating overlay */}
        {(status === 'connecting' || status === 'authenticating') && (
          <div className="absolute inset-0 bg-gray-900/80 flex items-center justify-center">
            <p className="text-gray-300 text-sm">
              {status === 'connecting' ? 'Connecting...' : `Authenticating as ${username}...`}
            </p>
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
                : status === 'connecting' || status === 'authenticating'
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
              : status === 'authenticating'
              ? `Authenticating as ${username}...`
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
              disabled={status === 'connecting' || status === 'authenticating'}
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