# 1. OBJECTIVE

Fix remaining 3 issues from all previous plans:

1. **Registry values** - Update to exact spec (os_info needs 86400 interval, os_update_check needs backgroundPollable: true)
2. **display_name column** - Add to widgets table schema  
3. **display_name rendering** - WidgetFrame uses display_name instead of prop title

**Context:** Most items are done. Only 3 minor issues remain.

# 2. CONTEXT SUMMARY

### What's Already Done:
- Theme toggle in Header
- Server list API with full data
- EditServerModal exists
- Sidebar links to server dashboard
- isLeader() fixed
- WidgetSettingsDialog exists (modal)
- s6 poller service exists
- Dockerfile copies poller.js

### Remaining Issues:
1. registry.ts - os_info interval = 60, should be 86400; os_update_check backgroundPollable = false, should be true
2. widgets table - missing display_name column
3. WidgetFrame - shows prop title, not display_name

# 3. APPROACH OVERVIEW

Fix 3 targeted issues.

# 4. IMPLEMENTATION STEPS

## Step 1: Fix Registry Values
- Update os_info: defaultPollInterval: 86400, defaultTTL: 15552000, storageMode: 'change_only'
- Update os_update_check: backgroundPollable: true, defaultPollInterval: 86400, defaultTTL: 15552000, storageMode: 'change_only'
- Reference: src/components/widgets/registry.ts

## Step 2: Add display_name Column
- Add to migration: ALTER TABLE widgets ADD COLUMN display_name TEXT DEFAULT NULL
- Reference: src/lib/db/migrations/index.ts

## Step 3: Render display_name in WidgetFrame
- Fetch widget data to get display_name
- Use: const displayTitle = widgetData?.display_name || title
- Reference: src/components/dashboard/WidgetFrame.tsx

# 5. TESTING AND VALIDATION

- Registry: os_info shows 86400 interval; os_update_check is backgroundPollable
- Migration: widgets table has display_name column
- WidgetFrame: Shows custom display_name when set
