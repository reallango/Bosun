# 1. OBJECTIVE

Fix the SSH terminal widget key duplication bug - every keypress and paste is being sent TWICE to the SSH server, causing characters to appear doubled.

## Current State Analysis (May 2026):

### ✅ What's Already Working:
- SSH Terminal widget in frontend (xterm.js with WebSocket client)
- `/api/ws-token` endpoint for authentication
- Frontend connects successfully to WebSocket
- **ws-server.js has PLACEHOLDER code** (lines 144-175) that just echoes input:
  ```
  ws.send('\r\n\x1b[32mConnected to Bosun SSH terminal\x1b[0m\r\n');
  ws.send('Session: ' + sessionId + ', Server: ' + serverId + '\r\n\r\n');
  // Echo locally for now (until SSH connected)
  ws.send(json.data);
  ```
- ssh2 library is in package.json dependencies
- decrypt() exists in src/lib/crypto/keys.ts
- MASTER_KEY is configured in environment

### ❌ What's MISSING (Critical):
1. **`queryRqlite()` function** - Doesn't exist anywhere in ws-server.js
2. **`Client` import** from ssh2 - Not imported  
3. **`decrypt()` function** - Not available in ws-server.js
4. **HTTP client for rqlite** - No way to query database from ws-server.js
5. **`connectToServer()` function** - Never created
6. **Real SSH connection** - Never established

# 2. CONTEXT SUMMARY

## Bug Location:
File: `src/components/widgets/ssh-terminal/SSHTerminalWidget.tsx`

## Root Cause:
The component has **TWO separate term.onData() handlers** that both send data to WebSocket:

1. **Handler 1** (lines 186-192): `useEffect` with empty deps `[]` - runs once on mount
2. **Handler 2** (lines 225-235): `useEffect` with `[status]` - runs when status changes to 'connected'

When the WebSocket connects and status becomes 'connected', the second useEffect fires and adds a **duplicate** onData handler. Every keypress is then sent TWICE - once from handler 1 and once from handler 2.

## Evidence:
- `ls` becomes `llss` (key typed twice)
- `ls`paste becomes `lsls` (paste typed twice)
- Both handlers call `ws.send(data)` on the same WebSocket

# 3. APPROACH OVERVIEW

## Corrected Approach:

**Opus's instructions are mostly CORRECT in their logic, but they FAIL to mention that several prerequisite functions don't exist.** We need to:

1. **Create helper functions** that Opus assumes already exist:
   - `queryRqlite()` - Simple wrapper around rqlite HTTP API
   - `decrypt()` - Reimplement from keys.ts

2. **Import ssh2 Client** - Add the import statement

3. **Implement connectToServer()** function - Exactly as Opus specifies

4. **Replace connection handler** with real SSH flow - Exactly as Opus specifies

This approach is preferred because:
- It follows the ssh2 library's documented patterns
- It uses the same encryption approach already in the codebase
- It maintains bidirectional streaming architecture already working in the frontend

## Issues with Opus's Instructions:

1. **Missing detail:** Doesn't mention that queryRqlite() doesn't exist
2. **Missing detail:** Doesn't mention that decrypt() needs to be added
3. **Potential bug in resize handling:** Opus shows `sshStream.setWindow(parsed.rows, parsed.cols, parsed.rows, parsed.cols)` - the last two parameters appear duplicated (should likely be colOffset, rowOffset or just remove them)

# 4. IMPLEMENTATION STEPS

## Phase 1: Remove Duplicate Handler
**Goal:** Fix the duplicate keypress bug

### Step 1.1: Remove duplicate useEffect
- **Method:** Delete the second useEffect block (lines 225-235) in SSHTerminalWidget.tsx
- **Reference:** `src/components/widgets/ssh-terminal/SSHTerminalWidget.tsx`
- The first handler in the initial useEffect (lines 186-192) should be the ONLY handler
- Delete this block entirely:
```javascript
// Update term and ws refs when they change (for reconnect)
useEffect(() => {
  const term = termRef.current;
  const ws = wsRef.current;

  if (term && ws?.readyState === WebSocket.OPEN) {
    term.onData((data) => {
      ws.send(data);
    });
  }
}, [status]);
```

# 5. TESTING AND VALIDATION

## Acceptance Criteria:
- Type single character - should appear ONCE
- Type `ls` - should show as `ls` not `llss`
- Paste text - should appear once, not duplicated
- Arrow keys navigate correctly (not doubled)
- Exit command closes session properly

## Verification:
- Reload the terminal widget
- Type keys and verify no duplication
- Check browser console for any errors
