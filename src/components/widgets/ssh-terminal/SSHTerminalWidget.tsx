'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface SSHTerminalWidgetProps {
  widgetId: string;
  serverId: string;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export function SSHTerminalWidget({ widgetId, serverId }: SSHTerminalWidgetProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [sessionId] = useState(() => Math.random().toString(36).substring(2, 11));

  // Get WebSocket URL from environment
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3002';

  // Connect to WebSocket server
  const connect = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN || status === 'connecting') {
      return;
    }

    setStatus('connecting');
    setError(null);

    try {
      // Get a short-lived WebSocket token
      const tokenRes = await fetchWithAuth('/api/ws-token', { method: 'POST' });
      const tokenJson = await tokenRes.json();

      if (!tokenJson.data?.token) {
        throw new Error(tokenJson.error?.message || 'Failed to get WebSocket token');
      }

      const wsToken = tokenJson.data.token;

      // Build WebSocket URL
      const url = new URL(wsUrl);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('serverId', serverId);
      url.searchParams.set('token', wsToken);

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        console.log('[WS] Connected');

        // Send initial resize
        if (termRef.current) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: termRef.current.cols,
            rows: termRef.current.rows
          }));
        }
      };

      ws.onmessage = (event) => {
        if (termRef.current && status === 'connected') {
          termRef.current.write(event.data);
        }
      };

      ws.onclose = (event) => {
        setStatus('disconnected');
        console.log('[WS] Disconnected:', event.code, event.reason);
      };

      ws.onerror = (event) => {
        console.error('[WS] Error:', event);
        setError('WebSocket connection error');
        setStatus('error');
      };

    } catch (err: any) {
      console.error('[WS] Connection error:', err);
      setError(err.message || 'Failed to connect');
      setStatus('error');
    }
  }, [sessionId, serverId, wsUrl, status]);

  // Disconnect from WebSocket server
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  // Reconnect handler
  const reconnect = useCallback(() => {
    disconnect();
    setTimeout(() => connect(), 500);
  }, [connect, disconnect]);

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current) return;

    // Inject xterm CSS if not already present
    if (!document.getElementById('xterm-css')) {
      const link = document.createElement('link');
      link.id = 'xterm-css';
      link.rel = 'stylesheet';
      link.href = '/xterm.css';
      document.head.appendChild(link);
    }

    // Create terminal
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

    // Create fit addon
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Open terminal in DOM
    term.open(terminalRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Set up terminal input handler
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: termRef.current?.cols,
            rows: termRef.current?.rows
          }));
        }
      }
    };

    // Set up resize observer on container
    resizeObserverRef.current = new ResizeObserver(handleResize);
    if (terminalRef.current?.parentElement) {
      resizeObserverRef.current.observe(terminalRef.current.parentElement);
    }

    // Auto-connect on mount
    connect();

    // Cleanup on unmount
    return () => {
      disconnect();
      resizeObserverRef.current?.disconnect();
      term.dispose();
    };
  }, []); // Only run once on mount

  // Update term and ws refs when they change (for reconnect)
  useEffect(() => {
    const term = termRef.current;
    const ws = wsRef.current;

    if (term && ws?.readyState === WebSocket.OPEN) {
      term.onData((data) => {
        ws.send(JSON.stringify({ type: 'input', data }));
      });
    }
  }, [status]);

  // Handle control buttons
  const handleConnect = () => {
    if (status === 'disconnected' || status === 'error') {
      connect();
    }
  };

  const handleDisconnect = () => {
    disconnect();
  };

  const handleReconnect = () => {
    reconnect();
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
        
        {/* Error overlay */}
        {error && (
          <div className="absolute inset-0 bg-red-900/80 flex items-center justify-center p-4">
            <div className="text-center">
              <p className="text-red-200 text-sm mb-2">Connection Error</p>
              <p className="text-red-100 text-xs mb-3">{error}</p>
              <button
                onClick={reconnect}
                className="px-3 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded"
              >
                Reconnect
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
          ) : (
            <button
              onClick={status === 'error' ? handleReconnect : handleConnect}
              disabled={status === 'connecting'}
              className="px-2 py-0.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded disabled:opacity-50"
            >
              {status === 'error' ? 'Reconnect' : 'Connect'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}