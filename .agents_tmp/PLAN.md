# 1. OBJECTIVE

Background Polling Implementation - Fix remaining issues after scan.

**SCAN RESULTS - What's DONE vs NEEDED:**

| Fix | Status | Issue |
|-----|--------|-------|
| 1. Leader election | ⚠️ PARTIAL | isLeader() broken - returns true always |
| 2. Registry values | ❌ WRONG | Values don't match spec |
| 3. s6 service | ✅ DONE | |
| 4. Dockerfile copy | ✅ DONE | |
| 5. Settings dialog | ❌ IS PAGE | Change to modal dialog |
| 6. OS Update widget | ⚠️ PARTIAL | Incomplete |
| 7. display_name | ❌ MISSING | Not in migration |
| 8. display_name render | ❌ MISSING | Need to render |
| 9. ssh2 version | ✅ DONE | |
| 10. SHA-256 | ✅ DONE | |
| 11. Exclude widgets | ✅ DONE | |
| 12. Settings dialog | ❌ NOT CREATED | |

**REMAINING FIXES:**

1. Fix isLeader() function - check json.store?.raft?.state === 'Leader'
2. Update registry.ts with EXACT values (see spec)
3. Delete settings page, create WidgetSettingsDialog.tsx (modal)
4. Complete OS Update widget UI elements
5. Add display_name to migration
6. Render display_name in WidgetFrame header
7. Add delete custom command warning dialog

# 2. CONTEXT SUMMARY

### Existing Implementation:
- SSH Connection Pool already exists at `src/lib/ssh/connection-pool.ts`
- Widget system in place
- No background polling - widgets fetch on page load

# 3. APPROACH OVERVIEW

**Background polling architecture:**
- Only rqlite leader runs poller (checks every 10s)
- Polls based on widget existence  
- Per-job intervals via last_polled_at
- Cache-first reads for widgets
- change_only storage for slow metrics

# 4. IMPLEMENTATION STEPS

## Phase 1: Database Schema + Registry
- Create widget_polling_config table (with last_polled_at)
- Create widget_data_cache table  
- Add widgets.display_name column
- Update registry with backgroundPollable, defaultPollInterval, defaultTTL, storageMode
- Register os_update_check widget
- Set custom_command: backgroundPollable = false

## Phase 2: Widget Settings UI
- Create WidgetSettingsDialog.tsx
- Add Settings to widget menu (⋮)
- Create settings API route: /api/widgets/[widgetId]/settings

## Phase 3: SSH Connection Pool - REUSE
- Import existing src/lib/ssh/connection-pool.ts

## Phase 4: Background Poller Service
- Create poller.js
- Create s6-overlay/s6-rc.d/poller/* files
- Implement last_polled_at tracking per (server, widget_type)
- Exclude custom_command from discovery query
- Implement both storage modes (latest_ttl, change_only)

## Phase 5: Widget API Cache Integration
- Read from widget_data_cache first
- Fall back to live SSH if cache empty
- Return collected_at + stale flag

## Phase 6: OS Update Check Widget
- Create OSUpdateCheckWidget.tsx
- Create check-updates API
- Create install-updates API  
- Add checkForUpdates(), installUpdates() to adapters

## Phase 7: TTL Cleanup
- Auto-delete expired latest_ttl rows
- Change-only: only store when hash changes
- change_only rows: delete after 6 months
- Cleanup when widgets/servers removed

# 5. TESTING AND VALIDATION

- Single instance: poller collects data, widgets show cached
- Cache miss: falls back to live SSH
- Poll intervals respected (not polling too often)
- Display name persists per instance
- Leadership transition: poller moves to new leader
- OS Update: check, install, reboot indicator work
