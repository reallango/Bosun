# 1. OBJECTIVE

Implement the REAL SSH terminal connection in theBosun WebSocket server (ws-server.js), replacing placeholder code with actual ssh2 connections. The goal is to enable users to connect to servers via SSH from the browser-based terminal widget.

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

## Current System Architecture:
- **Frontend:** Next.js 14 running on port 3042
- **WebSocket Server:** Separate Node.js process (ws-server.js) on port 3002
- **Database:** rqlite on port 4001 (HTTP API)
- **Frontend ↔ WebSocket:** WebSocket connection to ws-server.js via /ws/terminal

## Key Files:
- `ws-server.js` - WebSocket server that NEEDS to be updated
- `src/components/widgets/ssh-terminal/SSHTerminalWidget.tsx` - Frontend ✅ Works
- `src/lib/db/rqlite-client.ts` - Has RqliteClient class (HTTP-based)
- `src/lib/crypto/keys.ts` - Has decrypt() function

## What Opus Instructions Assume vs Reality:

| Assumption in Opus Instructions | Reality |
|------------------------------|---------|
| "queryRqlite() already exists" | ❌ Doesn't exist - must CREATE |
| "decrypt() already exists" | ❌ Not in ws-server.js - either import or reimplement |
| "MASTER_KEY already exists" | ✅ Exists as env var |
| "ssh2 Client import" | ❌ Not imported - must add import |
| "rqlite accessible" | Need HTTP calls since ws-server.js runs separately |

## Dependencies:
- `ssh2` - Already in package.json ✅
- `ws` - Already in package.json ✅
- Need: rqlite HTTP client (can reimplement simple fetch-based version)

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

## Phase 1: Add Missing Imports and Helper Functions
**Goal:** Create the helper functions that Opus assumes exist

### Step 1.1: Import ssh2 Client
- **Method:** Add import statement at top of ws-server.js
- **Code:** `import { Client } from 'ssh2';`
- **Reference:** ws-server.js (line 1)

### Step 1.2: Create queryRqlite() function
- **Method:** Create simple fetch-based wrapper for rqlite HTTP API
- **Code:**
```javascript
async function queryRqlite(sql) {
  const res = await fetch(`http://${RQLITE_HOST}/db/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([[sql]]),
  });
  const json = await res.json();
  const result = json.results?.[0];
  if (result?.error) throw new Error(result.error);
  return result?.values || [];
}
```
- **Reference:** ws-server.js (add after the constants section)

### Step 1.3: Create decrypt() function
- **Method:** Implement AES-256-GCM decryption (same logic as keys.ts)
- **Code:** Reimplement the decrypt() function from keys.ts
- **Reference:** ws-server.js (add after queryRqlite)

---

## Phase 2: Create connectToServer() Function
**Goal:** Create the SSH connection function

### Step 2.1: Implement connectToServer()
- **Method:** Create function to connect to server via SSH using ssh2
- **Code:** Use Opus's exact implementation (verified)
- **Reference:** Add after the helper functions

### Step 2.2: Add sshSessions Map
- **Method:** Add Map for tracking open sessions
- **Code:** `const sshSessions = new Map();`
- **Reference:** ws-server.js (global section)

---

## Phase 3: Replace Connection Handler with Real SSH
**Goal:** Replace placeholder code with actual SSH connection

### Step 3.1: Update wss.on('connection') handler
- **Method:** Replace lines 143-175 with Opus's exact implementation
- **Reference:** ws-server.js

### Step 3.2: Verify resize handling (potential bug)
- **Method:** The code `setWindow(rows, cols, rows, cols)` may have a bug
- **Suggested fix:** `setWindow(rows, cols)` (just 2 params) - Let the code agent verify against ssh2 documentation
- **Reference:** ws-server.js resize handler section

---

## Phase 4: Verification
**Goal:** Verify the implementation works

### Testing Steps:
- **Build:** `docker compose build --no-cache && docker compose up -d`
- **Connect:** Open browser to terminal widget
- **Verify:** Should see real shell prompt (`bosun-svc@hostname:~$`)
- **Commands:** Test `whoami`, `ls`, arrow keys, Ctrl+C
- **Check logs:** Should see real connection, not placeholder message

# 5. TESTING AND VALIDATION

## Acceptance Criteria:

| Criterion | How to Verify |
|-----------|---------------|
| ✅ connectToServer() EXISTS | Search for function definition in ws-server.js |
| ✅ queryRqlite() EXISTS | Search for function in ws-server.js |
| ✅ decrypt() EXISTS | Search for function in ws-server.js |
| ✅ ssh2 Client imported | Look for `import { Client }` in ws-server.js |
| No placeholder messages | Should NOT see "Connected to Bosun SSH terminal" echo message |
| No "echo for now" comments | Should NOT see comments about echoes |
| Real SSH connection | Docker logs should show: `[WS] Client connected: session=...` |
| Real shell prompt | Browser should show real prompt like `user@host:~$` |
| Resize works | Terminal resizes when window resizes |
| Cleanup on close | Docker logs show proper cleanup when tab closed |

## Verification Commands:

```bash
# Build and start
docker compose build --no-cache && docker compose up -d

# Check logs for connection
docker logs bosun 2>&1 | grep -i "ssh\|ws"

# Should see real connection (not placeholder)
# Expected: [WS] Client connected: session=xxx, server=xxx

# In browser terminal, test:
whoami   # Should return service account name
ls      # Should list files
exit    # Should close session cleanly
```
