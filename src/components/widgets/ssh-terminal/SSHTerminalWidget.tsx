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
  // Windows: password captured by the modal. It is fed to the PTY when the
  // nested ssh prompts (like sshpass, but without piping stdin, which would
  // turn off the TTY and make ssh print a banner instead of an interactive
  // session).
  const passwordRef = useRef('');
  
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
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
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

    // Windows switches accounts with a nested ssh, so collect the password in
    // a modal while the service-account shell initializes.
    if (platformRef.current === 'windows') {
      passwordRef.current = '';
      setPasswordInput('');
      setShowPasswordModal(true);
    }

    // Reset all auth refs
    suSentRef.current = false;
    authenticatedRef.current = false;
    authBufferRef.current = '';
    passwordPromptShownRef.current = false;
    servicePromptRef.current = '';
    userMarkerSentRef.current = false;
    passwordRef.current = '';
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

        // Start auth timeout. Windows gets longer because the user types a
        // password into the modal before the nested ssh completes.
        const authTimeoutMs = platformRef.current === 'windows' ? 120000 : 15000;
        authTimeoutRef.current = setTimeout(() => {
          if (!authenticatedRef.current) {
            console.log('[WS] Auth timeout');
            setShowPasswordModal(false);
            setError('Authentication timed out');
            ws.close();
            setStatus('error');
            statusRef.current = 'error';
          }
        }, authTimeoutMs);
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

        // ========== AUTH PHASE (Linux: interactive `su -`) ==========
        // Windows uses a password modal + nested ssh; see WINDOWS NESTED-SSH
        // AUTH below.
        if (!authenticatedRef.current && platformRef.current !== 'windows') {
          authBufferRef.current += data;

          // Phase 2: Send su after first output (service shell ready)
          if (!suSentRef.current && !authenticatedRef.current) {
            if (suSentRef.current) return;

            const promptMatch = authBufferRef.current.match(/\S+@\S+[:#$]\s*$/m);
            if (promptMatch) {
              servicePromptRef.current = promptMatch[0].trim();
              console.log('[WS] Captured service prompt:', servicePromptRef.current);
            }

            setTimeout(() => {
              if (suSentRef.current || authenticatedRef.current) return;
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(`su - ${userToUse}\r`);
                console.log('[WS] Sent su command for', userToUse);
                suSentRef.current = true;
              }
            }, 500);
            return; // Don't display the service-account prompt
          }

          // Phase 3: Detect Password: prompt -> show terminal
          if (!passwordPromptShownRef.current &&
              authBufferRef.current.toLowerCase().includes('password')) {
            passwordPromptShownRef.current = true;
            authBufferRef.current = '';
            setStatus('connected');
            statusRef.current = 'connected';
            if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
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

          // After password prompt shown, pass output to terminal
          if (passwordPromptShownRef.current) {
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

            if (data.includes(userToUse + '@') ||
                (authBufferRef.current.includes(userToUse + '@'))) {
              authenticatedRef.current = true;
              suSentRef.current = true;
              if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
              authBufferRef.current = '';
              console.log('[WS] Authentication successful for', userToUse);
              tsm.setSessionStatus(widgetId, 'connected');
              return;
            }

            if (termRef.current) {
              termRef.current.write(data);
              tsm.appendToBuffer(widgetId, data);
            }
          }

          return;
        }

        // ========== WINDOWS NESTED-SSH AUTH ==========
        // The password modal drives the prompt + input. Here we feed the
        // password when ssh asks, then confirm the account with the BOSUN_USER
        // marker and clear the screen on success.
        if (!authenticatedRef.current && platformRef.current === 'windows') {
          // Wait for the service-account shell to be ready, then start the
          // nested ssh login. The password is answered from the modal.
          if (!suSentRef.current) {
            authBufferRef.current += data;
            if (/(?:^|\r?\n)\s*(?:PS\s+)?[A-Za-z]:\\[^\r\n>]*>\s*$/.test(authBufferRef.current)) {
              suSentRef.current = true;
              authBufferRef.current = '';
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(`ssh -t -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no ${userToUse}@localhost powershell\r`);
              }
            }
            return;
          }

          if (!passwordPromptShownRef.current) {
            // Detect the nested-ssh password prompt and answer it with the
            // password captured by the modal.
            const tail = authBufferRef.current + data;
            if (/password\s*:\s*$/i.test(tail.trimEnd()) ||
                /@[^\s']*'s password:\s*$/i.test(tail.trimEnd())) {
              passwordPromptShownRef.current = true;
              authBufferRef.current = '';
              if (passwordRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(passwordRef.current + '\r');
              }
            } else {
              authBufferRef.current = tail;
            }
            return;
          }

          const clean = data
            .replace(/\r?\n?[^\r\n]*@[^\r\n]*'s password:\s*/gi, '')
            .replace(/\r?\n?Warning: Permanently added[^\r\n]*/gi, '')
            .replace(/\r?\n?The authenticity of host[^\r\n]*/gi, '')
            .replace(/\r?\n?Are you sure you want to continue connecting[^\r\n]*/gi, '');
          if (clean) authBufferRef.current += clean;

          // A second password prompt means the previous password was rejected.
          if (/password\s*:\s*$/i.test(data.trimEnd()) ||
              /@[^\s']*'s password:\s*$/i.test(data.trimEnd())) {
            if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
            cleanup();
            setShowPasswordModal(false);
            setError('Login failed - check your username and password');
            setStatus('error');
            statusRef.current = 'error';
            return;
          }

          // Once a shell is up, ask it to print its username so we can confirm
          // the account. The echoed command and its output are never displayed
          // (the screen is cleared on success).
          if (!userMarkerSentRef.current &&
              /(?:^|\r?\n)\s*(?:PS\s+)?[A-Za-z]:\\[^\r\n>]*>\s*$/.test(authBufferRef.current)) {
            userMarkerSentRef.current = true;
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send('Write-Output ("BOSUN_USER=" + $env:USERNAME)\r');
            }
            return;
          }

          // The echoed marker command contains "BOSUN_USER=" but is not the
          // result, so require a line that *starts* with the marker (the
          // echoed command line starts with "Write-Output").
          const marker = authBufferRef.current.match(/(?:^|\r?\n)\s*BOSUN_USER=([^\r\n]+)/);
          if (marker) {
            // $env:USERNAME is normally bare, but strip any DOMAIN\ prefix so
            // the comparison is robust.
            const norm = (v: string) => v.trim().toLowerCase().split('\\').pop() || '';
            const who = norm(marker[1]);
            if (who && who !== norm(userToUse)) {
              if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
              cleanup();
              setShowPasswordModal(false);
              setError('Login failed - could not switch to your account');
              setStatus('error');
              statusRef.current = 'error';
              return;
            }
            authenticatedRef.current = true;
            suSentRef.current = true;
            if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
            authBufferRef.current = '';
            setShowPasswordModal(false);
            setStatus('connected');
            statusRef.current = 'connected';
            tsm.setSessionStatus(widgetId, 'connected');
            // Wipe the auth noise so the session opens on a clean shell.
            if (termRef.current) {
              termRef.current.write('\x1b[2J\x1b[H');
              tsm.appendToBuffer(widgetId, '\x1b[2J\x1b[H');
            }
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

          if (/permission denied|access is denied|logon failure|1326|1327/i.test(authBufferRef.current)) {
            if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
            cleanup();
            setShowPasswordModal(false);
            setError('Login failed - check your username and password');
            setStatus('error');
            statusRef.current = 'error';
            return;
          }
          return;
        }

        // ========== NORMAL MODE ==========
        // Linux: returning to the service prompt means the su switch failed.
        if (platformRef.current !== 'windows' &&
            servicePromptRef.current && data.includes(servicePromptRef.current)) {
          console.log('[WS] Detected return to service account, closing session');
          cleanup();
          setError('Login failed - could not switch to your account');
          setStatus('error');
          statusRef.current = 'error';
          return;
        }

        // Windows: drop any late-arriving marker noise (the echoed command or
        // its output) so the clean screen isn't clobbered.
        let output = data;
        if (platformRef.current === 'windows' &&
            (output.includes('BOSUN_USER=') || /Write-Output\s*\(\s*"BOSUN_USER=/.test(output))) {
          output = output
            .split(/\r?\n/)
            .filter(l => !l.includes('BOSUN_USER=') && !/Write-Output\s*\(\s*"BOSUN_USER=/.test(l))
            .join('\r\n');
        }

        // Normal terminal output
        if (termRef.current) {
          termRef.current.write(output);
          // Gap 2: Append to scrollback buffer
          tsm.appendToBuffer(widgetId, output);
        }
      };

      ws.onclose = (event) => {
        if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
        console.log('[WS] Disconnected:', event.code, event.reason);
        setShowPasswordModal(false);
        setStatus('idle');
        statusRef.current = 'idle';
        
        // Gap 4: Update session status
        tsm.setSessionStatus(widgetId, 'disconnected');
      };

      ws.onerror = (event) => {
        if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
        console.error('[WS] Error:', event);
        setError('WebSocket connection error');
        setShowPasswordModal(false);
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
    setShowPasswordModal(false);
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

  // Submit the Windows password. If ssh has already prompted, send it now;
  // otherwise the auth handler sends it as soon as the prompt appears.
  const handlePasswordSubmit = () => {
    const pw = passwordInput;
    if (!pw) return;
    passwordRef.current = pw;
    setPasswordInput('');
    setShowPasswordModal(false);
    if (passwordPromptShownRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(pw + '\r');
    }
  };

  const handlePasswordCancel = () => {
    setPasswordInput('');
    setShowPasswordModal(false);
    cleanup();
    setStatus('idle');
    statusRef.current = 'idle';
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
        
        {/* Windows password modal */}
        {showPasswordModal && (
          <div className="absolute inset-0 bg-gray-900 flex items-center justify-center p-4 z-10">
            <div className="w-full max-w-xs bg-gray-800 border border-gray-600 rounded p-4">
              <p className="text-gray-200 text-sm mb-1">Enter password for</p>
              <p className="text-gray-400 text-xs mb-3 break-all">{username}</p>
              <input
                type="password"
                autoFocus
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handlePasswordSubmit()}
                placeholder="Password"
                className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-gray-200 text-sm mb-3"
              />
              <div className="flex gap-2">
                <button
                  onClick={handlePasswordSubmit}
                  disabled={!passwordInput}
                  className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Connect
                </button>
                <button
                  onClick={handlePasswordCancel}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Connecting/Authenticating overlay */}
        {!showPasswordModal && (status === 'connecting' || status === 'authenticating') && (
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