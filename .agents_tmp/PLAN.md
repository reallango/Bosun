# 1. OBJECTIVE

Fix 6 issues:

1. **Widget Settings** - No display_name field, popup centers on page not widget
2. **Server Widget Page** - Missing Portainer URL field in settings, missing ... menu with add widget/edit server
3. **Dark Mode Dropdowns** - Add widget server dropdown and widget settings storage mode showing white

**Context:** Earlier 3 fixes still needed plus 6 new issues.

# 2. CONTEXT SUMMARY

### Earlier Fixes (still needed):
1. Registry values - os_info needs 86400, os_update_check needs backgroundPollable: true
2. display_name column - missing from widgets table
3. display_name rendering - not showing in header

### New Issues:
4. WidgetSettingsDialog - missing display_name field, wrong centering
5. Server widget page - missing Portainer URL in edit, missing ... menu
6. Dark mode dropdowns - show white bg instead of dark theme

# 4. IMPLEMENTATION STEPS

## Earlier Fixes (from before):

## Step 1: Fix Registry Values (same)
- Update os_info: defaultPollInterval: 86400, defaultTTL: 15552000, storageMode: 'change_only'
- Update os_update_check: backgroundPollable: true
- Reference: src/components/widgets/registry.ts

## Step 2: Add display_name Column (same)
- Add to migration: ALTER TABLE widgets ADD COLUMN display_name TEXT DEFAULT NULL

## Step 3: Render display_name in WidgetFrame (same)
- Fetch widget data to get display_name

## New Issues:

## Step 4: Fix WidgetSettingsDialog
- Add display_name input field
- Fix centering: use fixed position centered, not widget-relative
- Reference: src/components/dialogs/WidgetSettingsDialog.tsx

## Step 5: Fix Server Settings + Widget Page
- Add Portainer URL field to edit server page: src/app/(dashboard)/settings/servers/[serverId]/page.tsx
- Add ... menu to server widget page at: src/app/(dashboard)/servers/[serverId]/page.tsx
- Menu options: Add Widget, Edit Settings

## Step 6: Fix Dark Mode Dropdowns
- Add dark theme classes to select elements
- For add widget server dropdown and storage mode dropdown
- Use: dark:bg-gray-800 dark:text-white dark:border-gray-600

# 5. TESTING AND VALIDATION

- Registry: os_info shows 86400; os_update_check pollable
- display_name: column exists, shows in widget header
- WidgetSettingsDialog: has display_name field, centers on page
- Server page: Portainer URL field, ... menu works
- Dark mode: dropdowns show dark theme
