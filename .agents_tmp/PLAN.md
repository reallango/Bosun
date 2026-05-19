# 1. OBJECTIVE

Fix remaining issues:

1. **AddWidgetModal** - Loading/error dropdowns missing dark mode
2. **Server widget page** - Add ... menu with Add Widget and Edit Settings  
3. **WidgetSettingsDialog** - Only one editable at a time, center on dashboard not widget

# 2. CONTEXT SUMMARY

### Already Done:
- Registry values (os_info 86400, os_update_check pollable)
- display_name column in migration
- WidgetSettingsDialog has display_name field
- Portainer URL in server settings
- AddWidgetModal main dropdown has dark mode

### Still Needed:
1. AddWidgetModal loading/error states need dark:bg-gray-800
2. Server widget page (/servers/[serverId]) needs ... menu
3. WidgetSettingsDialog should center on page not widget, only one open at a time

# 4. IMPLEMENTATION STEPS

## Step 1: Fix AddWidgetModal Dark Mode
- Add dark mode classes to disabled/loading dropdowns at lines 107, 111, 115
- Reference: src/components/dashboard/AddWidgetModal.tsx

## Step 2: Add ... Menu to Server Widget Page
- Add to src/app/(dashboard)/servers/[serverId]/page.tsx
- Use DropdownMenu like WidgetFrame
- Options: Add Widget, Edit Server Settings

## Step 3: Fix WidgetSettingsDialog
- Already centered on page (fixed position) ✅
- Add state to track if dialog is open (only one at a time)
- Reference: src/components/dialogs/WidgetSettingsDialog.tsx

# 5. TESTING AND VALIDATION

- AddWidgetModal: loading shows dark background
- Server page: ... menu visible and working
- Widget settings: only one dialog open at a time
