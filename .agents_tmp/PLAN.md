# 1. OBJECTIVE

Implement all missing features from the detailed design plan (`/workspace/Bosun_Full_Design_Plan.md`) to reach the complete v1.0 specification.

## Current State Analysis (Updated May 2026):

### ✅ Already Implemented:
- Authentication (login, setup, JWT)
- Server CRUD & SSH key management
- Dashboard system with widget grid layout
- Basic OS widgets (CPU, Memory, Network, Disk, OS Info, Server Summary)
- **Docker containers** API + widget (list, start/stop/restart, logs)
- **GPU Monitoring** widget + API
- **Ollama Status** widget + API
- **SSH Terminal** widget (xterm.js)
- Notification API routes (CRUD)
- Alert Rules API route
- Notification Channels API
- Audit Logs API
- rqlite integration
- SSH adapters (Ubuntu, Debian, Unraid, Generic Linux)
- useWebSocket hook

### Critical Missing Components:
1. ~~Docker Management API~~ ✅ DONE
2. ~~GPU Monitoring widget~~ ✅ DONE
3. ~~Ollama Status widget~~ ✅ DONE
4. ~~SSH Terminal widget~~ ✅ BUT NEEDS WebSocket server
5. **Docker Containers Widget** - API exists, widget component missing
6. **Widget Registration Fix** - NEW widgets not showing in Add Widget modal
7. **Custom Command Widget** - Not implemented
8. **Portainer Link Widget** - Not implemented
9. **Notification Delivery** - Webhook/email sending not built
10. **Alert Evaluator** - Alert evaluation/triggers not built
11. **WebSocket Server Routes** - Terminal/logs streaming endpoints
12. **Notification Provider** - In-app notification state management
13. **Settings Pages** - Alerts, Users, Audit Log UI
14. **Mobile Responsive** - Touch polish

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

## Phase 1: Widget Registration Fix ⚠️ CRITICAL
**Goal:** Fix new widgets not appearing in Add Widget modal

### Step 1.1: Update AddWidgetModal widget list
- **Method:** Add missing widgets to hardcoded list in AddWidgetModal.tsx
- **Reference:** `src/components/dashboard/AddWidgetModal.tsx`
- **Widgets to add:** gpu_monitoring, ollama_status, ssh_terminal, docker_containers

### Step 1.2: Update widget registry.ts
- **Method:** Add GPU, Ollama, SSH Terminal, Docker Containers to registry.ts
- **Reference:** `src/components/widgets/registry.ts`

### Step 1.3: Create Docker Containers widget
- **Method:** Build widget component showing container list with start/stop/restart actions
- **Reference:** `src/components/widgets/docker-containers/index.tsx`

### Step 1.4: Update WidgetFrame routing
- **Method:** Add case handler for docker_containers
- **Reference:** `src/components/dashboard/WidgetFrame.tsx`

---

## Phase 2: WebSocket Infrastructure
**Goal:** Enable real-time terminal, log streaming via WebSocket

### Step 2.1: Create Terminal WebSocket route
- **Method:** Create WebSocket handler connecting to SSH shell
- **Reference:** `src/app/api/ws/terminal/route.ts`

### Step 2.2: Create Docker Logs WebSocket route
- **Method:** Create WebSocket for streaming container logs
- **Reference:** `src/app/api/ws/docker-logs/route.ts`

### Step 2.3: Create Docker Events WebSocket route
- **Method:** Create WebSocket for Docker events stream
- **Reference:** `src/app/api/ws/docker-events/route.ts`

---

## Phase 3: Custom & Portainer Widgets
**Goal:** Add remaining widget types

### Step 3.1: Create Custom Command Widget
- **Method:** Allow users to define arbitrary SSH commands and display output
- **Reference:** `src/components/widgets/custom-command/index.tsx`

### Step 3.2: Create Portainer Link Widget
- **Method:** Store and display clickable Portainer URLs
- **Reference:** `src/components/widgets/portainer-link/index.tsx`

### Step 3.3: Update WidgetFrame routing
- **Method:** Add case handlers for custom_command, portainer_link
- **Reference:** `src/components/dashboard/WidgetFrame.tsx`

---

## Phase 4: Notifications & Alerts
**Goal:** Build complete notification system with delivery

### Step 4.1: Create Notifications lib
- **Method:** Implement webhook.ts (Discord/Slack), email.ts (nodemailer), in-app.ts
- **Reference:** `src/lib/notifications/`

### Step 4.2: Create Alert Evaluator lib
- **Method:** Implement alert rule evaluation, condition checking, trigger firing
- **Reference:** `src/lib/alerts/evaluator.ts`

### Step 4.3: Create Notification Provider
- **Method:** React context for in-app notification state
- **Reference:** `src/providers/NotificationProvider.tsx`

### Step 4.4: Create Notification Bell UI
- **Method:** Add notification bell to header with dropdown
- **Reference:** `src/components/layout/NotificationBell.tsx`

### Step 4.5: Add remaining API routes
- **Method:** Create alert-rules/[ruleId], notification-channels/[channelId] routes
- **Reference:** `src/app/api/`

---

## Phase 5: Settings Pages
**Goal:** Complete remaining UI pages

### Step 5.1: Create Alerts Settings page
- **Method:** UI for creating/editing alert rules
- **Reference:** `src/app/(dashboard)/settings/alerts/page.tsx`

### Step 5.2: Create Audit Log page
- **Method:** UI for viewing searchable audit log
- **Reference:** `src/app/(dashboard)/settings/audit-log/page.tsx`

### Step 5.3: Create Users Settings page
- **Method:** UI for user management (optional, based on design)
- **Reference:** `src/app/(dashboard)/settings/users/page.tsx`

---

## Phase 6: Mobile & Polish
**Goal:** Mobile responsiveness and final touches

### Step 6.1: Mobile responsive improvements
- **Method:** Add hamburger sidebar, stacked widgets, touch controls
- **Reference:** `src/components/layout/`, `src/components/dashboard/`

### Step 6.2: Header integration
- **Method:** Add NotificationBell and UserMenu to Header
- **Reference:** `src/components/layout/Header.tsx`

# 5. TESTING AND VALIDATION

Each phase has specific acceptance criteria for verification:

## Phase 1: Widget Registration Fix ⚠️
- [ ] Add Widget modal shows all available widgets
- [ ] Can add GPU Monitoring widget to dashboard
- [ ] Can add Ollama Status widget to dashboard
- [ ] Can add SSH Terminal widget to dashboard
- [ ] Can add Docker Containers widget to dashboard

## Phase 2: WebSocket Infrastructure
- [ ] Terminal WebSocket connects and provides shell
- [ ] Docker logs stream in real-time
- [ ] Docker events stream in real-time

## Phase 3: Custom & Portainer Widgets
- [ ] Custom Command widget executes defined commands
- [ ] Portainer Link widget displays stored URLs
- [ ] Both widgets appear in Add Widget modal

## Phase 4: Notifications & Alerts
- [ ] Notification bell shows unread count in header
- [ ] Webhook notifications send to Discord/Slack
- [ ] Email notifications send via SMTP
- [ ] Alert rules evaluated on schedule
- [ ] Alerts trigger correct notification channel

## Phase 5: Settings Pages
- [ ] Alerts page allows creating alert rules
- [ ] Audit Log page shows searchable history
- [ ] Users page shows user list (if implemented)

## Phase 6: Mobile & Polish
- [ ] Sidebar collapses on mobile
- [ ] Widgets stack on mobile screens
- [ ] Header shows NotificationBell
