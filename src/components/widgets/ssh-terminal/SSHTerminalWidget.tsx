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

type ConnectionStatus = 'idle' | 'connecting' | 'authenticating' | 'connected' | 'error' | 'disconnected';

export function SSHTerminalWidget({ widgetId, serverId }: SSHTerminalWidgetProps) {
  // Auth refs - use refs inside component (not state) to avoid stale closures in onmessage
  const suSentRef = useRef(false);
  const authenticatedRef = useRef(false);
  const authBufferRef = useRef('');
  const authTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordPromptShownRef = useRef(false);
  const servicePromptRef = useRef<string>('');
  // Windows: whether we've injected the identity marker command into the
  // user's shell (used to confirm we actually switched accounts).
  const userMarkerSentRef = useRef(false);
  // Windows auth-phase state:
  //  - windowsPreambleDoneRef: flips once the nested-ssh password prompt is seen.
  //    Before that, nothing is written to the terminal, so the service-account
  //    prompt and the echoed ssh command line never render.
  //  - sshUserRef: the service account (server.ssh_user), used to recognize the
  //    service-account prompt when the nested session exits.
  //  - confirmedUserRef: the account the BOSUN_USER marker confirmed.
  const windowsPreambleDoneRef = useRef(false);
  const sshUserRef = useRef('');
  const confirmedUserRef = useRef('');
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const statusRef = useRef<ConnectionStatus>('idle');
  const detachedRef = useRef(false); // Gap: true when terminal disposed but WS kept alive

  // Login username ref - accessible inside onmessage closure
  const loginUsernameRef = useRef('');
  // Server platform ('linux' | 'windows') - drives the auth command/flow
  const platformRef = useRef<string>('linux');

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState<string>(() => 
    localStorage.getItem(`bosun-terminal-user-${serverId}`) || ''
  );
  const sessionId = widgetId; // Deterministic based on widgetId

  // Sync username with ref
  useEffect(() => {
    loginUsernameRef.current = username;
  }, [username]);

  // Load the server platform once (cached in a ref). The auth flow differs:
  // Linux uses `su - <user>`, Windows uses a nested `ssh -t <user>@localhost`.
  const platformLoadedRef = useRef(false);
  const ensurePlatform = useCallback(async () => {
    if (platformLoadedRef.current) return platformRef.current;
    try {
      const res = await fetchWithAuth(`/api/servers/${serverId}`);
      const j = await res.json();
      platformRef.current = j.data?.platform === 'windows' ? 'windows' : 'linux';
      sshUserRef.current = (j.data?.ssh_user || '').trim();
    } catch {
      platformRef.current = 'linux';
    }
    platformLoadedRef.current = true;
    return platformRef.current;
  }, [serverId]);

  useEffect(() => { ensurePlatform(); }, [ensurePlatform]);

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
// keepAlive: if true, keep WebSocket session on server but release local terminal
  const cleanup = useCallback((keepAlive = false) => {
    const tsm = getTerminalSessionManager();
    
    // Notify session manager that we're detaching (keep session alive)
    if (keepAlive) {
      detachedRef.current = true; // Mark as detached, preserve auth state
      tsm.detachFromSession(widgetId);
      // Only detach terminal, keep WebSocket
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      fitAddonRef.current = null;
      // Clear resize observer
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      // Clear any pending auth timeouts
      if (authTimeoutRef.current) {
        clearTimeout(authTimeoutRef.current);
        authTimeoutRef.current = null;
      }
      // Clear auth buffer but keep auth state (suSentRef, authenticatedRef)
      // so reattach knows session is already authenticated
      authBufferRef.current = '';
      passwordPromptShownRef.current = false;
      servicePromptRef.current = '';
      userMarkerSentRef.current = false;
      windowsPreambleDoneRef.current = false;
      confirmedUserRef.current = '';
      tsm.setSessionStatus(widgetId, 'disconnected');
      return;
    }
    
    // Full destroy - close WebSocket and clean up completely
    tsm.destroySession(widgetId);
    
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
    detachedRef.current = false;
    suSentRef.current = false;
    authenticatedRef.current = false;
    authBufferRef.current = '';
    passwordPromptShownRef.current = false;
    servicePromptRef.current = '';
    userMarkerSentRef.current = false;
    windowsPreambleDoneRef.current = false;
    confirmedUserRef.current = '';
  }, [widgetId]);
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

    // Gap 3: Close any orphaned WebSocket from a previous session
    const tsm = getTerminalSessionManager();
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    // Also check session manager for existing WS
    const existingSession = tsm.getSession(widgetId);
    if (existingSession?.ws && existingSession.ws.readyState === WebSocket.OPEN) {
      console.log('[WS] Closing orphaned WebSocket from previous session');
      existingSession.ws.close();
      tsm.setSessionWebSocket(widgetId, null);
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

    // Gap 4: Register terminal with session manager
    tsm.setSessionTerminal(widgetId, term);

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

    // Resolve the platform before the WS so the auth flow (su vs nested ssh) is known.
    await ensurePlatform();

    setStatus('connecting');
    setError(null);

    // Reset all auth refs
    suSentRef.current = false;
    authenticatedRef.current = false;
    authBufferRef.current = '';
    passwordPromptShownRef.current = false;
    servicePromptRef.current = '';
    userMarkerSentRef.current = false;
    windowsPreambleDoneRef.current = false;
    confirmedUserRef.current = '';
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

      // Gap 4: Register session with session manager
      tsm.registerSession(widgetId, serverId, userToUse);
      tsm.setSessionWebSocket(widgetId, ws);
      tsm.setSessionStatus(widgetId, 'connecting');

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
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);

        // If detached (terminal disposed but WS kept alive), only buffer data
        if (detachedRef.current) {
          tsm.appendToBuffer(widgetId, data);
          return;
        }

        // ========== SESSION RESTORE CHECK ==========
        if (!authenticatedRef.current && data.includes('[Session restored]')) {
          console.log('[WS] Session restored - skipping auth');
          authenticatedRef.current = true;
          suSentRef.current = true; // Gap 3: preserve auth state
          statusRef.current = 'connected';
          setStatus('connected');
          
          // Gap 4: Update session status
          tsm.setSessionStatus(widgetId, 'connected');
          
          if (authTimeoutRef.current) {
            clearTimeout(authTimeoutRef.current);
            authTimeoutRef.current = null;
          }
          // Write restore marker + buffer replay to terminal
          if (termRef.current) {
            termRef.current.write(data);
            // Gap 2: Append to scrollback buffer
            tsm.appendToBuffer(widgetId, data);
          }
          // Re-fit terminal and send resize
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
          return;
        }

        // ========== AUTH PHASE ==========
        if (!authenticatedRef.current) {
          authBufferRef.current += data;

          // Phase 2: Send su after first output (bosun-svc shell ready)
          if (!suSentRef.current && !authenticatedRef.current) {
            // Double-check: make absolutely sure we haven't already sent it
            if (suSentRef.current) return;
            
            // Capture the service account prompt from initial shell output
            // Matches patterns like: bosun-svc@hostname:~$  or  user@host:/path#
            const promptMatch = authBufferRef.current.match(/\S+@\S+[:#$]\s*$/m);
            if (promptMatch) {
              servicePromptRef.current = promptMatch[0].trim();
              console.log('[WS] Captured service prompt:', servicePromptRef.current);
            }

            // Wait for the service shell to be ready before switching accounts
            setTimeout(() => {
              // Triple-check right before sending to prevent duplicates
              if (suSentRef.current || authenticatedRef.current) return;
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                if (platformRef.current === 'windows') {
                  // Windows has no `su`. `runas` opens a new console that does
                  // not attach to the SSH PTY (Win32-OpenSSH #1740), so instead
                  // open a nested SSH login to localhost as the target user.
                  // -t forces a PTY; password-only auth so it prompts (pubkey
                  // would otherwise log straight in as the service account).
                  // Leading space stops PowerShell echoing the command. The
                  // explicit `powershell` keeps the shell (and the BOSUN_USER
                  // marker below) deterministic regardless of the host's
                  // default shell.
                  wsRef.current.send(` ssh -t -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no ${userToUse}@localhost powershell\r`);
                  console.log('[WS] Sent nested ssh login for', userToUse);
                } else {
                  wsRef.current.send(`su - ${userToUse}\r`);
                  console.log('[WS] Sent su command for', userToUse);
                }
                suSentRef.current = true; // Set IMMEDIATELY before logging
              }
            }, 500);
            return; // Don't display the service-account prompt
          }

          // Phase 3: Detect Password: prompt -> show terminal. On Windows anchor
          // on the real nested-ssh prompt so the echoed command cannot trip it.
          if (!passwordPromptShownRef.current &&
              (platformRef.current === 'windows'
                ? (/password\s*:\s*$/i.test(authBufferRef.current.trimEnd()) ||
                   /@[^\s']*'s password:\s*$/i.test(authBufferRef.current.trimEnd()))
                : authBufferRef.current.toLowerCase().includes('password'))) {
            passwordPromptShownRef.current = true;
            windowsPreambleDoneRef.current = true;
            // Drop the pre-prompt buffer so the service-account prompt/output
            // cannot be mistaken for the user's own shell.
            authBufferRef.current = '';
            setStatus('connected');
            statusRef.current = 'connected';
            // Clear the timeout since we got password prompt
            if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
            // Windows: give the user a bounded window to enter the password and
            // reach their own shell; otherwise close (never stay on the service
            // account). Linux keeps its existing behaviour.
            if (platformRef.current === 'windows') {
              authTimeoutRef.current = setTimeout(() => {
                if (!authenticatedRef.current) {
                  cleanup();
                  setError('Login failed - could not switch to your account');
                  setStatus('error');
                  statusRef.current = 'error';
                }
              }, 60000);
            }
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
            // Show a clean password prompt. On Windows the nested ssh prints
            // its own `<user>@<host>'s password:` line; suppress that preamble
            // and synthesize `Password: ` instead.
            if (termRef.current) {
              termRef.current.write('Password: ');
            }
            return;
          }

          // After password prompt shown, pass output to terminal
          if (passwordPromptShownRef.current) {
            // Windows: confirm the account switch with an identity marker, and
            // tear down on any failure (never fall back to the service account).
            if (platformRef.current === 'windows') {
              // Defensive: never render anything before the preamble (password
              // prompt) is done, so the service prompt / echoed command can't leak.
              if (!windowsPreambleDoneRef.current) return;
              // Strip the nested-ssh preamble/host-key notices from the display.
              const clean = data
                .replace(/\r?\n?[^\r\n]*@[^\r\n]*'s password:\s*/gi, '')
                .replace(/\r?\n?Warning: Permanently added[^\r\n]*/gi, '')
                .replace(/\r?\n?The authenticity of host[^\r\n]*/gi, '')
                .replace(/\r?\n?Are you sure you want to continue connecting[^\r\n]*/gi, '');
              // Buffer the raw output (keeps the BOSUN_USER marker for
              // detection) but never show the echoed marker command or its line.
              if (clean) {
                authBufferRef.current += clean;
                const display = clean
                  .split(/\r?\n/)
                  .filter(l => !l.includes('BOSUN_USER=') && !/Write-Output\s*\(\s*"BOSUN_USER=/.test(l))
                  .join('\n');
                if (display && termRef.current) {
                  termRef.current.write(display);
                  tsm.appendToBuffer(widgetId, display);
                }
              }

              // Once a shell is up (user's or service's), ask it to print its
              // username so we can tell which account we actually got. The
              // marker line is captured but never written to the terminal.
              if (!userMarkerSentRef.current &&
                  /(?:^|\r?\n)\s*(?:PS\s+)?[A-Za-z]:\\[^\r\n>]*>\s*$/.test(authBufferRef.current)) {
                userMarkerSentRef.current = true;
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send('Write-Output ("BOSUN_USER=" + $env:USERNAME)\r');
                }
                return;
              }

              const marker = authBufferRef.current.match(/BOSUN_USER=([^\r\n]+)/);
              if (marker) {
                const who = marker[1].trim().toLowerCase();
                if (who && who !== userToUse.toLowerCase()) {
                  // Wrong account (e.g. the service account) - do NOT stay here.
                  if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
                  cleanup();
                  setError('Login failed - could not switch to your account');
                  setStatus('error');
                  statusRef.current = 'error';
                  return;
                }
                authenticatedRef.current = true;
                suSentRef.current = true;
                confirmedUserRef.current = who;
                servicePromptRef.current = '';
                if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
                authBufferRef.current = '';
                tsm.setSessionStatus(widgetId, 'connected');
                setTimeout(() => {
                  if (fitAddonRef.current && termRef.current) {
                    try { fitAddonRef.current.fit(); } catch {}
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                      wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
                    }
                  }
                }, 100);
                return;
              }

              // Failure detection (bad password, denied, etc.).
              if (/permission denied|access is denied|denied|logon failure|1326|1327/i.test(authBufferRef.current)) {
                if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
                cleanup();
                setError('Login failed - check your username and password');
                setStatus('error');
                statusRef.current = 'error';
                return;
              }
              return;
            }

            // ---- Linux (su) ----
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
              suSentRef.current = true; // Gap 3: preserve auth state
              if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
              authBufferRef.current = '';
              console.log('[WS] Authentication successful for', userToUse);

              // Gap 4: Update session status
              tsm.setSessionStatus(widgetId, 'connected');

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
                // Gap 2: Append to scrollback buffer
                tsm.appendToBuffer(widgetId, data);
              }
              return;
            }

            // Normal pass-through during password entry
            if (termRef.current) {
              termRef.current.write(data);
              // Gap 2: Append to scrollback buffer
              tsm.appendToBuffer(widgetId, data);
            }
          }

          return;
        }

        // ========== NORMAL MODE ==========
        // Windows: the nested ssh session has ended (or we are back on the
        // service account) - close instead of leaving the user on bosun-svc.
        if (platformRef.current === 'windows') {
          const svcUser = sshUserRef.current;
          const backOnService = !!svcUser &&
            confirmedUserRef.current !== '' &&
            /PS\s+[^\r\n>]*>/.test(data) &&
            data.includes(svcUser);
          if (/Connection to localhost closed\./i.test(data) || backOnService) {
            console.log('[WS] Nested session ended, closing');
            cleanup();
            setError('Session closed');
            setStatus('disconnected');
            statusRef.current = 'disconnected';
            return;
          }
        }

        // Linux: returning to the service prompt means the su switch failed.
        if (servicePromptRef.current && data.includes(servicePromptRef.current)) {
          console.log('[WS] Detected return to service account, closing session');
          cleanup();
          setError('Login failed - could not switch to your account');
          setStatus('error');
          statusRef.current = 'error';
          return;
        }

        // Normal terminal output
        if (termRef.current) {
          termRef.current.write(data);
          // Gap 2: Append to scrollback buffer
          tsm.appendToBuffer(widgetId, data);
        }
      };

      ws.onclose = (event) => {
        if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
        console.log('[WS] Disconnected:', event.code, event.reason);
        setStatus('idle');
        statusRef.current = 'idle';
        
        // Gap 4: Update session status
        tsm.setSessionStatus(widgetId, 'disconnected');
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
  }, [username, sessionId, serverId, cleanup, ensurePlatform]); // Removed status from deps

  // Disconnect from WebSocket server - FULL destroy (user clicked disconnect button)
  const disconnect = useCallback(() => {
    cleanup(false); // keepAlive = false - destroy session completely
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

    // Cleanup on unmount - detach but KEEP session alive on server
    // This allows session to persist across dashboard switches
    return () => {
      cleanup(true); // keepAlive = true
    };
  }, [cleanup]);

  // Auto-reconnect on mount if username saved - Gap 1: Check for existing session
  useEffect(() => {
    const tsm = getTerminalSessionManager();
    const existingSession = tsm.getSession(widgetId);
    
    // Gap 1: Reattach if WebSocket is live (status may be 'disconnected' from cleanup, but session might still be alive)
    if (existingSession?.ws && existingSession.ws.readyState === WebSocket.OPEN) {
      console.log('[TSM] Found existing session, reattaching:', widgetId);
      
      // Create new Terminal
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
      
      // Gap 1: Replay scrollback buffer
      const buffer = tsm.getBuffer(widgetId);
      for (const chunk of buffer) {
        term.write(chunk);
      }
      
      // Gap 1: Wire up events to existing WebSocket
      const ws = existingSession.ws;
      
      // Clear detached flag - we're back
      detachedRef.current = false;
      
      // Set refs
      wsRef.current = ws;
      authenticatedRef.current = true;
      suSentRef.current = true;
      
      // Set status
      setStatus('connected');
      statusRef.current = 'connected';
      tsm.setSessionStatus(widgetId, 'connected');
      tsm.setSessionTerminal(widgetId, term);
      
      // Re-wire terminal input -> WebSocket
      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });
      
      // Re-wire resize
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
      
      // ================================================================
      // REATTACH: Re-wire WebSocket handlers to NEW component refs
      // ================================================================
      // NOTE: We MUST re-wire ws.onmessage here. React creates new ref objects on each
      // mount, so the old handler from connect() closures over dead refs from the
      // previous component instance. The new handler uses this component's refs.
      
      // Re-wire ws.onmessage — MUST replace old handler which closures over dead refs
      ws.onmessage = (event) => {
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        
        // If detached again (another unmount happened), only buffer
        if (detachedRef.current) {
          tsm.appendToBuffer(widgetId, data);
          return;
        }
        
        // Normal authenticated output — write to terminal and buffer
        if (termRef.current) {
          termRef.current.write(data);
        }
        tsm.appendToBuffer(widgetId, data);
      };
      
      // Re-wire ws.onclose
      ws.onclose = (event) => {
        console.log('[WS] Disconnected (reattached session):', event.code, event.reason);
        setStatus('idle');
        statusRef.current = 'idle';
        tsm.setSessionStatus(widgetId, 'disconnected');
      };
      
      // Re-wire ws.onerror
      ws.onerror = (event) => {
        console.error('[WS] Error (reattached session):', event);
        setStatus('error');
        statusRef.current = 'error';
        tsm.setSessionStatus(widgetId, 'error');
      };
      
      // ================================================================
      // END REATTACH
      // ================================================================
      
      // Gap 1: Update session ws to ensure consistent
      tsm.setSessionWebSocket(widgetId, ws);
      
      console.log('[TSM] Reattached to session:', widgetId);
      return; // Skip regular connect
    }
    
    // No auto-connect when no existing session - let user manually click Connect
  }, []); // Only on mount

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