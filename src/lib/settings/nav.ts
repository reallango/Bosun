/**
 * One list of settings pages: the settings navigation and the command palette both read it, so adding a page is one
 * line here and it becomes findable without a second list. Order matches the URL tree.
 */

export interface SettingsNavItem {
  href: string;
  label: string;
  /** Only active on the exact path (the settings index). */
  exact?: boolean;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'You',
    items: [
      { href: '/settings/account', label: 'Account' },
      { href: '/settings/ssh-keys', label: 'SSH keys' },
    ],
  },
  {
    label: 'Servers',
    items: [
      { href: '/settings/servers', label: 'Servers' },
      { href: '/settings/cluster', label: 'Cluster' },
      { href: '/settings/alerts', label: 'Alerts' },
    ],
  },
  {
    label: 'Access',
    items: [
      { href: '/settings/users', label: 'Users' },
      { href: '/settings/permissions', label: 'Permissions' },
      { href: '/settings/api-access', label: 'API access' },
      { href: '/settings/access-requests', label: 'Access requests' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/settings', label: 'General', exact: true },
      { href: '/settings/widgets', label: 'Widgets' },
      { href: '/settings/updates', label: 'Updates' },
      { href: '/settings/database', label: 'Database' },
      { href: '/settings/audit-log', label: 'Audit log' },
    ],
  },
];
