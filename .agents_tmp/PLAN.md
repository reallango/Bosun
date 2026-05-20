# 1. OBJECTIVE

Fix white background issues in dark mode for dropdown boxes and UI elements. When users enable dark mode, any dropdown boxes or other UI elements that currently show white backgrounds should display the correct dark theme color instead.

# 2. CONTEXT SUMMARY

The project is a Next.js application using Tailwind CSS with a dark mode implementation that uses the `dark:` prefix. The theme is set via `ThemeProvider.tsx` which adds `dark` class to the root element when dark mode is active.

### Components with white backgrounds that need dark mode fixes:

1. **AddWidgetModal.tsx** - Disabled select dropdowns (loading, error, no servers) are missing dark mode (lines 108, 112, 116)
2. **audit-log/page.tsx** - Select dropdown, input field, and table container missing dark mode (lines 54, 67, 78)
3. **alerts/page.tsx** - Form container, select dropdowns, and rule cards missing dark mode (lines 84, 92, 100, 128)

### Already properly fixed:
- WidgetFrame.tsx dropdown ✅
- AddWidgetModal main dropdown ✅
- WidgetSettingsDialog ✅
- DeleteConfirmDialog ✅
- NotificationBell ✅
- Header ✅
- EditServerModal ✅
- DashboardToolbar ✅
- settings/page.tsx ✅

# 4. IMPLEMENTATION STEPS

## Step 1: Fix AddWidgetModal disabled dropdowns
- File: `src/components/dashboard/AddWidgetModal.tsx`
- Add `dark:bg-gray-800` to disabled select elements at lines 108, 112, 116
- Reference: Lines 107-118 use `bg-gray-50 dark:bg-gray-800` in some places but not all

## Step 2: Fix audit-log/page.tsx dark mode
- File: `src/app/(dashboard)/settings/audit-log/page.tsx`
- Add dark mode to select dropdown (line 54)
- Add dark mode to input field (line 67)
- Add dark mode to table container bg-white (line 78)

## Step 3: Fix alerts/page.tsx dark mode
- File: `src/app/(dashboard)/settings/alerts/page.tsx`
- Add dark mode to form container (line 84)
- Add dark mode to select dropdowns (lines 92, 100)
- Add dark mode to rule card containers (line 128)

# 5. TESTING AND VALIDATION

**Success Criteria:**
1. Navigate to Settings → Audit Log in dark mode - select dropdowns and table should use dark backgrounds
2. Navigate to Settings → Alerts in dark mode - form and rule cards should use dark backgrounds
3. Open Add Widget modal in dark mode with no servers - dropdown should be dark
