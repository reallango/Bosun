# 1. OBJECTIVE

Implement all missing features from the detailed design plan (`/workspace/Bosun_Full_Design_Plan.md`) to reach the complete v1.0 specification.

## Current State Analysis:
The codebase has a solid foundation covering:
- ✅ Authentication (login, setup, JWT, session management)
- ✅ Server CRUD & SSH key management
- ✅ Dashboard system with widget grid layout
- ✅ Basic OS widgets (CPU, Memory, Network, Disk, OS Info)
- ✅ rqlite integration & cluster status
- ✅ SSH adapters (Ubuntu, Debian, Unraid, Generic Linux)

## Critical Missing Components:
1. Docker Management (container CRUD, logs, stats, events)
2. GPU Monitoring
3. Ollama/Ollama AI Stack Monitoring
4. WebSocket support for real-time data
5. Terminal Widget (xterm.js)
6. Custom Command Widgets
7. Notification System (in-app, webhook, email)
8. Alert Rules & Alert Evaluation
9. Audit Logging API & UI
10. Portainer Link Widget
11. Mobile Responsive Polish

# 2. CONTEXT SUMMARY

## System Components Already Built:
- **Frontend:** Next.js 14, Tailwind, shadcn/ui components
- **Dashboard:** react-grid-layout with saveable layouts
- **Auth System:** JWT-based with login/setup flows
- **Server Management:** CRUD operations, health checks via SSH
- **SSH Layer:** OS-specific adapters (Ubuntu, Debian, Unraid, Generic Linux)
- **rqlite:** Database integration with migrations

## Required New Components:
| Component | Current State | Required |
|-----------|---------------|----------|
| **Docker Management** | Not implemented | Full container lifecycle (list, start, stop, restart, logs, stats) |
| **WebSocket API** | REST only | Real-time terminal, logs streaming, widget data |
| **Terminal Widget** | Not implemented | xterm.js integration |
| **GPU Monitoring** | Not implemented | nvidia-smi parsing widget |
| **Ollama Monitoring** | Not implemented | API status, models, running pulls |
| **Notifications** | Not implemented | In-app + webhook + email channels |
| **Alert System** | Not implemented | Alert rules + evaluator + triggers |
| **Audit Log** | Logger exists | API + UI for viewing |

## Technical Dependencies (to add to package.json):
- `xterm` (^5.x) - Terminal emulator
- `xterm-addon-fit` - Auto-fit terminal to container
- `ws` (^8.x) - WebSocket library
- `nodemailer` - Email notifications

## Key Files Requiring Updates:
1. `package.json` - Add missing dependencies
2. `src/lib/db/schema.ts` - Add notification/alert tables
3. `src/app/api/` - Add docker routes, websocket routes, notifications
4. `src/components/widgets/` - Add Docker/GPU/Ollama widgets

# 3. APPROACH OVERVIEW

This plan follows a phased implementation approach based on the design document phases, prioritizing infrastructure first, then building up to advanced features:

**Phase A: Foundation & Dependencies**
- Add missing npm dependencies (xterm, ws, nodemailer)
- Add database migrations for notifications/alerts

**Phase B: Docker Management**
- Implement container listing, start/stop/restart operations
- Add logs and stats endpoints
- Create Docker Containers widget

**Phase C: Real-Time Infrastructure**
- Add WebSocket API routes for terminal, logs, and notifications
- Create useWebSocket hook

**Phase D: Widgets Expansion**
- GPU Monitoring widget
- Ollama Status widget
- Terminal widget
- Custom Command widget

**Phase E: Notifications & Alerts**
- Database tables for notifications/alerts
- In-app notification system
- Webhook/email notification channels
- Alert rule creation and evaluation

**Phase F: UI Polish & Mobile**
- Audit log UI page
- Mobile responsive refinements
- Portainer link widget

# 4. IMPLEMENTATION STEPS

## Phase A: Foundation & Dependencies Setup
**Goal:** Add required dependencies and prepare database schema

### Step A.1: Add npm dependencies
- **Method:** Install `xterm`, `xterm-addon-fit`, `ws`, `nodemailer`
- **Reference:** `package.json`

### Step A.2: Database migrations for notifications/alerts
- **Method:** Add schema tables for notifications, alert_rules, notification_channels, audit_log
- **Reference:** `src/lib/db/schema.ts`, `src/lib/db/migrations/`

---

## Phase B: Docker Management
**Goal:** Full container lifecycle management via SSH (no Docker socket)

### Step B.1: Add Docker SSH commands to adapters
- **Method:** Add `listContainers`, `startContainer`, `stopContainer`, `restartContainer`, `getContainerLogs`, `getContainerStats` to OS adapters
- **Reference:** `src/lib/ssh/adapters/*.ts`

### Step B.2: Create Docker container API routes
- **Method:** Implement endpoints for listing containers, container actions (start/stop/restart), logs, stats
- **Reference:** `src/app/api/servers/[serverId]/containers/route.ts`, `.../[containerId]/action/route.ts`, `.../logs/route.ts`

### Step B.3: Create Docker Containers widget
- **Method:** Build widget showing container list with status, actions
- **Reference:** `src/components/widgets/docker-containers/index.tsx`

---

## Phase C: Real-Time Infrastructure (WebSocket)
**Goal:** Enable live terminal, log streaming, and push notifications

### Step C.1: WebSocket server setup
- **Method:** Create WebSocket route handlers
- **Reference:** `src/app/api/ws/terminal/route.ts`, `src/app/api/ws/docker-logs/route.ts`

### Step C.2: useWebSocket hook
- **Method:** Create React hook for WebSocket management
- **Reference:** `src/hooks/useWebSocket.ts`

---

## Phase D: Widgets Expansion
**Goal:** Add GPU, Ollama, Terminal, and Custom Command widgets

### Step D.1: GPU Monitoring Widget
- **Method:** Create widget parsing nvidia-smi output via SSH
- **Reference:** `src/components/widgets/gpu-monitoring/index.tsx`

### Step D.2: Ollama Status Widget
- **Method:** Create widget querying Ollama API (curl localhost:11434)
- **Reference:** `src/components/widgets/ollama-status/index.tsx`

### Step D.3: SSH Terminal Widget
- **Method:** Integrate xterm.js with WebSocket for live shell
- **Reference:** `src/components/widgets/ssh-terminal/index.tsx`

### Step D.4: Custom Command Widget
- **Method:** Allow users to define arbitrary SSH commands and display output
- **Reference:** `src/components/widgets/custom-command/index.tsx`

---

## Phase E: Notifications & Alerts
**Goal:** Build alert system with multiple notification channels

### Step E.1: Notification types and provider
- **Method:** Create types, provider, and hook
- **Reference:** `src/types/notification.ts`, `src/providers/NotificationProvider.tsx`

### Step E.2: Notifications API routes
- **Method:** CRUD for notifications, marking read/dismissed
- **Reference:** `src/app/api/notifications/route.ts`

### Step E.3: Alert rules system
- **Method:** Create alert rule creation, evaluation logic, and triggers
- **Reference:** `src/app/api/alert-rules/route.ts`, `src/lib/alerts/evaluator.ts`

### Step E.4: Notification channels (webhook/email)
- **Method:** Implement webhook sender and email sender
- **Reference:** `src/lib/notifications/webhook.ts`, `src/lib/notifications/email.ts`

### Step E.5: Notification Bell UI
- **Method:** Add to header with dropdown
- **Reference:** `src/components/layout/NotificationBell.tsx`

---

## Phase F: UI Polish & Advanced Features
**Goal:** Complete the remaining UI pages and refinements

### Step F.1: Audit Log UI page
- **Method:** Create settings page to view audit log
- **Reference:** `src/app/(dashboard)/settings/audit-log/page.tsx`

### Step F.2: Portainer Link Widget
- **Method:** Create widget storing Portainer URLs and linking to them
- **Reference:** `src/components/widgets/portainer-link/index.tsx`

### Step F.3: Mobile responsive refinements
- **Method:** Add mobile-specific CSS, touch controls for widgets
- **Reference:** `src/app/globals.css`, `src/components/dashboard/`

---

## Phase G: Docker Events & Advanced Docker
**Goal:** Real-time Docker event streaming and health monitoring

### Step G.1: Docker events WebSocket
- **Method:** Stream Docker events via WebSocket
- **Reference:** `src/app/api/ws/docker-events/route.ts`

### Step G.2: Docker health checks integration
- **Method:** Add container health check status to container list
- **Reference:** `src/lib/ssh/adapters/*.ts`

# 5. TESTING AND VALIDATION

Each phase has specific acceptance criteria for verification:

## Phase A: Foundation & Dependencies
- [ ] Dependencies install without errors (`npm install`)
- [ ] Database migrations run successfully on startup
- [ ] Application builds without errors (`npm run build`)

## Phase B: Docker Management
- [ ] Can list all containers on a server via SSH
- [ ] Can start/stop/restart containers from UI
- [ ] Can view container logs in widget
- [ ] Can view container stats in widget

## Phase C: Real-Time Infrastructure
- [ ] WebSocket connection establishes for terminal
- [ ] Terminal input/output flows in real-time
- [ ] Docker logs stream in real-time

## Phase D: Widgets Expansion
- [ ] GPU widget shows VRAM usage, temperature, utilization
- [ ] Ollama widget shows model list and status
- [ ] Terminal widget allows full shell interaction
- [ ] Custom Command widget runs saved commands

## Phase E: Notifications & Alerts
- [ ] Notification bell shows unread count
- [ ] Clicking notification navigates to related item
- [ ] Alert rules can be created with conditions
- [ ] Alert triggers send webhook notification
- [ ] Alert triggers send email notification

## Phase F: UI Polish & Advanced Features
- [ ] Audit log page shows filterable action history
- [ ] Portainer Link widget displays clickable links
- [ ] Mobile: sidebar collapses to hamburger
- [ ] Mobile: widgets stack in single column

## Phase G: Docker Events & Advanced Docker
- [ ] Docker events stream in real-time via WebSocket
- [ ] Container health check status displays in container list
