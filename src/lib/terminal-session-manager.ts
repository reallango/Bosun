/**
 * Terminal Session Manager - maintains persistent SSH sessions across dashboard switches
 * 
 * This module provides a singleton that manages terminal sessions on the client side.
 * Sessions are keyed by widgetId and persist even when the component unmounts.
 */

import { Terminal } from '@xterm/xterm';

export interface TerminalSessionConfig {
  serverId: string;
  username: string;
}

export interface TerminalSessionState {
  widgetId: string;
  serverId: string;
  username: string;
  status: 'connecting' | 'authenticating' | 'connected' | 'idle' | 'error' | 'disconnected';
  ws: WebSocket | null;
  term: Terminal | null;
  createdAt: number;
  lastActivity: number;
}

// Singleton instance
let sessionManagerInstance: TerminalSessionManager | null = null;

class TerminalSessionManager {
  private sessions: Map<string, TerminalSessionState> = new Map();
  
  private constructor() {
    // Clean up all sessions on page unload
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.destroyAll();
      });
    }
  }
  
  static getInstance(): TerminalSessionManager {
    if (!sessionManagerInstance) {
      sessionManagerInstance = new TerminalSessionManager();
    }
    return sessionManagerInstance;
  }
  
  /**
   * Get or create a session entry for a widget
   */
  getOrCreateSession(widgetId: string): TerminalSessionState | null {
    return this.sessions.get(widgetId) || null;
  }
  
  /**
   * Register a new session
   */
  registerSession(widgetId: string, serverId: string, username: string): TerminalSessionState {
    // Check if session already exists
    const existing = this.sessions.get(widgetId);
    if (existing) {
      return existing;
    }
    
    const session: TerminalSessionState = {
      widgetId,
      serverId,
      username,
      status: 'idle',
      ws: null,
      term: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    
    this.sessions.set(widgetId, session);
    console.log('[TSM] Created session:', widgetId);
    return session;
  }
  
  /**
   * Update session status
   */
  setSessionStatus(widgetId: string, status: TerminalSessionState['status']): void {
    const session = this.sessions.get(widgetId);
    if (session) {
      session.status = status;
      session.lastActivity = Date.now();
    }
  }
  
  /**
   * Update session WebSocket
   */
  setSessionWebSocket(widgetId: string, ws: WebSocket | null): void {
    const session = this.sessions.get(widgetId);
    if (session) {
      session.ws = ws;
      session.lastActivity = Date.now();
    }
  }
  
  /**
   * Update session terminal
   */
  setSessionTerminal(widgetId: string, term: Terminal | null): void {
    const session = this.sessions.get(widgetId);
    if (session) {
      session.term = term;
      session.lastActivity = Date.now();
    }
  }
  
  /**
   * Check if a session exists and is connected
   */
  hasActiveSession(widgetId: string): boolean {
    const session = this.sessions.get(widgetId);
    return session !== undefined && session.status === 'connected';
  }
  
  /**
   * Detach from session (keep alive but release terminal)
   */
  detachFromSession(widgetId: string): void {
    const session = this.sessions.get(widgetId);
    if (session) {
      session.term = null;
      session.lastActivity = Date.now();
      console.log('[TSM] Detached from session:', widgetId);
    }
  }
  
  /**
   * Destroy a specific session
   */
  destroySession(widgetId: string): void {
    const session = this.sessions.get(widgetId);
    if (session) {
      // Close WebSocket if exists
      if (session.ws) {
        session.ws.close();
        session.ws = null;
      }
      // Dispose terminal if exists
      if (session.term) {
        session.term.dispose();
        session.term = null;
      }
      this.sessions.delete(widgetId);
      console.log('[TSM] Destroyed session:', widgetId);
    }
  }
  
  /**
   * Destroy all sessions (cleanup on tab close)
   */
  destroyAll(): void {
    console.log('[TSM] Destroying all sessions, count:', this.sessions.size);
    // Iterate over all widget IDs
    const widgetIds = Array.from(this.sessions.keys());
    for (const widgetId of widgetIds) {
      this.destroySession(widgetId);
    }
  }
  
  /**
   * Get all active sessions
   */
  getAllSessions(): TerminalSessionState[] {
    return Array.from(this.sessions.values());
  }
  
  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

/**
 * Get singleton instance of TerminalSessionManager
 */
export function getTerminalSessionManager(): TerminalSessionManager {
  return TerminalSessionManager.getInstance();
}