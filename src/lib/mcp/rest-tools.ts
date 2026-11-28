/**
 * MCP tools that mirror the REST API.
 *
 * Each tool names one route handler and method. The dispatcher invokes that handler in-process with the MCP
 * caller's own credentials, so authentication, permission checks, resource limits, rate limiting, audit logging
 * and validation are exactly the REST route's. This file only declares names, descriptions, input schemas and
 * how tool arguments map to path/query/body.
 */
import type { CatalogTool, HttpMethod, ObjectJsonSchema, RestQueryParam } from './types';

type Schema = Record<string, unknown>;

const str = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra });
const bool = (description: string): Schema => ({ type: 'boolean', description });
const int = (description: string, extra: Schema = {}): Schema => ({ type: 'integer', description, ...extra });
const obj = (description: string, extra: Schema = {}): Schema => ({ type: 'object', description, additionalProperties: true, ...extra });
const arr = (description: string, items: Schema, extra: Schema = {}): Schema => ({ type: 'array', description, items, ...extra });

const SERVER_ID = str('Server id (call servers_list to find one).', { minLength: 1, maxLength: 128 });
const ID = (what: string): Schema => str(`${what} id.`, { minLength: 1, maxLength: 128 });

interface Def {
  name: string;
  title: string;
  description: string;
  method: HttpMethod;
  route: string;
  path?: Record<string, string>;
  query?: Array<string | RestQueryParam>;
  body?: 'none' | 'rest' | 'all';
  bodyRoot?: string;
  keepConfirm?: boolean;
  binary?: 'form-file' | 'raw';
  properties?: Record<string, Schema>;
  required?: string[];
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  confirmText?: string;
  /** Extra route+method pairs this one tool covers (e.g. server_command covers both exec routes). */
  extraRoutes?: string[];
}

function def(d: Def): CatalogTool {
  const properties: Record<string, Schema> = { ...(d.properties ?? {}) };
  const required = [...(d.required ?? [])];
  if (d.confirmText) {
    properties.confirm = { type: 'boolean', const: true, description: `Must be true. ${d.confirmText}` };
    required.push('confirm');
  }
  const inputSchema: ObjectJsonSchema = {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
  return {
    kind: 'rest',
    name: d.name,
    title: d.title,
    description: d.description,
    inputSchema,
    annotations: {
      readOnlyHint: d.readOnly === true,
      openWorldHint: d.openWorld === true,
      ...(d.destructive ? { destructiveHint: true } : {}),
    },
    rest: {
      route: d.route,
      method: d.method,
      ...(d.path ? { path: d.path } : {}),
      ...(d.query ? { query: d.query } : {}),
      body: d.body ?? (d.method === 'GET' || d.method === 'DELETE' ? 'none' : 'rest'),
      ...(d.bodyRoot ? { bodyRoot: d.bodyRoot } : {}),
      ...(d.keepConfirm ? { keepConfirm: true } : {}),
      ...(d.binary ? { binary: d.binary } : {}),
    },
    routes: [`${d.method} ${d.route}`, ...(d.extraRoutes ?? [])],
    ...(d.confirmText ? { requiresConfirm: true, confirmText: d.confirmText } : {}),
  };
}

export function restTools(): CatalogTool[] {
  return [
    // ---- Servers ---------------------------------------------------------------------------------------------
    def({
      name: 'server_create', title: 'Add a server', method: 'POST', route: 'servers', openWorld: true,
      description: 'Add a server by name, hostname and SSH details (same body as POST /api/servers). Full access only.',
      properties: {
        name: str('Display name.', { minLength: 1, maxLength: 100 }),
        hostname: str('Hostname or IP address.', { minLength: 1, maxLength: 255 }),
        ssh_port: int('SSH port (default 22).', { minimum: 1, maximum: 65535 }),
        ssh_user: str('SSH user (the service account).'),
        ssh_key_id: str('SSH key id for ssh_user (see ssh_keys_list).'),
        shell_user: str('Non-admin shell account (give it with shell_key_id).'),
        shell_key_id: str('SSH key id for the non-admin shell account.'),
        platform: str('Platform.', { enum: ['linux', 'windows'] }),
        notes: str('Notes.'),
        tags: arr('Tags.', { type: 'string' }),
        mac_address: str('Primary MAC address for Wake-on-LAN.'),
        mac_address_alt: str('Alternate MAC address.'),
        host_key_fingerprint: str('Pinned host key (SHA256:...), optional.'),
      },
      required: ['name', 'hostname', 'ssh_user'],
    }),
    def({
      name: 'server_update', title: 'Update a server', method: 'PATCH', route: 'servers/[serverId]',
      path: { serverId: 'server_id' }, openWorld: true,
      description: 'Update a server record (same fields as PATCH /api/servers/{id}). Full access only.',
      properties: {
        server_id: SERVER_ID, name: str('Display name.'), hostname: str('Hostname or IP address.'),
        ssh_port: int('SSH port.', { minimum: 1, maximum: 65535 }), ssh_user: str('SSH user.'), ssh_key_id: str('SSH key id.'),
        shell_user: str('Non-admin shell account (null clears it).'),
        shell_key_id: str('SSH key id for the non-admin shell account (null clears it).'),
        platform: str('Platform.', { enum: ['linux', 'windows'] }), notes: str('Notes.'), tags: arr('Tags.', { type: 'string' }),
        poll_enabled: bool('Poll this server.'), poll_interval_sec: int('Poll interval in seconds.', { minimum: 5, maximum: 3600 }),
        os_type: str('Detected OS type.'), os_version: str('Detected OS version.'), os_codename: str('Detected OS codename.'),
        kernel_version: str('Detected kernel version.'),
        mac_address: str('Primary MAC address.'), mac_address_alt: str('Alternate MAC address.'),
        host_key_fingerprint: { type: ['string', 'null'], description: 'Set to null to trust the host key again.' },
      },
      required: ['server_id'],
    }),
    def({
      name: 'server_delete', title: 'Delete a server', method: 'DELETE', route: 'servers/[serverId]',
      path: { serverId: 'server_id' }, destructive: true,
      confirmText: 'Deleting a server removes its dashboards, widgets, history and alerts. This cannot be undone.',
      description: 'Delete a server and everything that hangs off it. Full access only. Requires confirm: true.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'server_test', title: 'Test a server connection', method: 'POST', route: 'servers/[serverId]/test',
      path: { serverId: 'server_id' }, openWorld: true,
      description: 'Test the SSH connection and credentials of a server. Full access only.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'server_detect', title: 'Detect a server', method: 'POST', route: 'servers/[serverId]/detect',
      path: { serverId: 'server_id' }, openWorld: true,
      description: 'Detect the operating system, version and capabilities of a server over SSH. Full access only.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'server_health', title: 'Server health', method: 'GET', route: 'servers/[serverId]/health',
      path: { serverId: 'server_id' }, readOnly: true,
      description: 'Host health for one server: load, memory, disk and service checks from its latest poll.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'server_nics', title: 'Server network interfaces', method: 'GET', route: 'servers/[serverId]/nics',
      path: { serverId: 'server_id' }, readOnly: true,
      description: 'Network interfaces and MAC addresses last reported by a server.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'server_setup', title: 'Server setup instructions', method: 'GET', route: 'servers/[serverId]/setup',
      path: { serverId: 'server_id' }, readOnly: true,
      description: 'The setup/provisioning instructions and state for a server.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'server_bosun_status', title: 'Bosun deployment status', method: 'GET', route: 'servers/[serverId]/bosun',
      path: { serverId: 'server_id' }, readOnly: true,
      description: 'Whether Bosun is deployed on a server and how (same as GET /api/servers/{id}/bosun). Full access only.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'server_bosun_deploy', title: 'Deploy Bosun to a server', method: 'POST', route: 'servers/[serverId]/bosun',
      path: { serverId: 'server_id' }, destructive: true, openWorld: true, keepConfirm: true,
      confirmText: 'Deploying Bosun starts containers on the target host.',
      description: 'Deploy Bosun on a server in join or standalone mode. Full access only. Requires confirm: true.',
      properties: {
        server_id: SERVER_ID, mode: str('Deployment mode.', { enum: ['join', 'standalone'] }),
        node_name: str('Optional node name.'),
      },
      required: ['server_id', 'mode'],
    }),
    def({
      name: 'server_provision', title: 'Provision a server', method: 'POST', route: 'servers/provision',
      openWorld: true, destructive: true,
      confirmText: 'Provisioning creates or repairs accounts and installs keys on the target host.',
      description: 'Provision a new server: create the service and non-admin accounts and install Bosun keys (same body as POST /api/servers/provision). Full access only.',
      properties: {
        name: str('Display name.'), hostname: str('Hostname or IP address.'), port: int('SSH port.', { minimum: 1, maximum: 65535 }),
        admin_username: str('Administrator login.'), admin_password: str('Administrator password (never stored).'),
        platform: str('Platform.', { enum: ['linux', 'windows'] }), service_account: str('Service account name.'),
        shell_account: str('Non-admin shell account name.'), ssh_user: str('Existing SSH user, when keeping a login.'),
        keep_key_id: str('Existing key to keep.'), fingerprints: arr('Host key fingerprints to accept.', { type: 'string' }),
        replace_keys: bool('Replace existing Bosun keys.'), create_shell_account: bool('Create the non-admin shell account.'),
        server_id: SERVER_ID,
      },
      required: ['name', 'hostname', 'admin_username', 'admin_password'],
    }),
    def({
      name: 'server_provision_keys', title: 'Inspect leftover SSH keys', method: 'POST', route: 'servers/provision/keys',
      openWorld: true,
      description: 'List keys on a host that look like an earlier Bosun\'s, so they can be cleaned up (same body as POST /api/servers/provision/keys). Full access only.',
      properties: {
        hostname: str('Hostname or IP address.'), port: int('SSH port.', { minimum: 1, maximum: 65535 }),
        admin_username: str('Administrator login.'), admin_password: str('Administrator password (never stored).'),
        platform: str('Platform.', { enum: ['linux', 'windows'] }), service_account: str('Service account name.'),
        keep_key_id: str('Key to keep.'), fingerprints: arr('Host key fingerprints to accept.', { type: 'string' }),
      },
      required: ['hostname', 'admin_username', 'admin_password'],
    }),
    def({
      name: 'portainer_get', title: 'Get Portainer settings', method: 'GET', route: 'servers/[serverId]/portainer',
      path: { serverId: 'server_id' }, readOnly: true,
      description: 'Portainer connection settings for a server (the API key is not returned). Full access (signed-in).',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'portainer_configure', title: 'Configure Portainer', method: 'PUT', route: 'servers/[serverId]/portainer',
      path: { serverId: 'server_id' }, openWorld: true,
      description: 'Set the Portainer URL, API key and endpoint for a server. Full access (signed-in).',
      properties: {
        server_id: SERVER_ID, url: str('Portainer URL.'), api_key: str('Portainer API key (never returned).'),
        insecure: bool('Allow an invalid TLS certificate.'), endpoint_id: int('Portainer endpoint id.'),
      },
      required: ['server_id', 'url'],
    }),
    def({
      name: 'portainer_disconnect', title: 'Disconnect Portainer', method: 'DELETE', route: 'servers/[serverId]/portainer',
      path: { serverId: 'server_id' }, destructive: true, confirmText: 'The stored Portainer connection and API key are removed.',
      description: 'Remove a server\'s Portainer connection. Full access (signed-in). Requires confirm: true.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'portainer_stacks_list', title: 'List Portainer stacks', method: 'GET', route: 'servers/[serverId]/portainer/stacks',
      path: { serverId: 'server_id' }, readOnly: true, openWorld: true,
      description: 'Stacks Portainer manages for a server. Full access (signed-in).',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),
    def({
      name: 'portainer_import', title: 'Import a stack from Portainer', method: 'POST', route: 'servers/[serverId]/portainer/import',
      path: { serverId: 'server_id' }, destructive: true, openWorld: true,
      confirmText: 'Importing creates or replaces a Bosun stack from Portainer.',
      description: 'Import one Portainer stack (or a running container) into Bosun. Full access (signed-in). Requires confirm: true.',
      properties: {
        server_id: SERVER_ID, name: str('Stack or container name.'), from: str('Source.', { enum: ['portainer', 'containers'] }),
        detach: bool('Detach it from Portainer.'),
      },
      required: ['server_id', 'name', 'from'],
    }),
    def({
      name: 'portainer_detach', title: 'Detach a Portainer stack', method: 'POST', route: 'servers/[serverId]/portainer/detach',
      path: { serverId: 'server_id' }, destructive: true, openWorld: true,
      confirmText: 'Detaching stops Portainer from managing the stack.',
      description: 'Detach a Portainer-managed stack. Full access (signed-in). Requires confirm: true.',
      properties: { server_id: SERVER_ID, name: str('Stack name.') }, required: ['server_id', 'name'],
    }),
    def({
      name: 'server_power', title: 'Restart or shut down a server', method: 'POST', route: 'servers/[serverId]/power',
      path: { serverId: 'server_id' }, destructive: true, openWorld: true, keepConfirm: true,
      confirmText: 'Restarting or shutting down a host interrupts everything running on it.',
      description: 'Restart or shut down a server over SSH. Needs power.restart or power.shutdown. Requires confirm: true.',
      properties: {
        server_id: SERVER_ID, action: str('What to do.', { enum: ['restart', 'shutdown'] }),
      },
      required: ['server_id', 'action'],
    }),
    def({
      name: 'server_wake', title: 'Wake a server', method: 'POST', route: 'servers/[serverId]/wake',
      path: { serverId: 'server_id' }, openWorld: true,
      description: 'Send a Wake-on-LAN packet to a server. Needs power.wake. Non-admins may only wake the server\'s own MACs.',
      properties: {
        server_id: SERVER_ID, action: str('wake (default) or install the wakeonlan utility (Full access).', { enum: ['wake', 'install'] }),
        mac_address: str('Optional MAC override (Full access only).'), broadcast: str('Optional broadcast address (Full access only).'),
      },
      required: ['server_id'],
    }),

    // ---- Schedules -------------------------------------------------------------------------------------------
    def({
      name: 'schedule_get', title: 'Get a schedule', method: 'GET', route: 'schedules/[id]',
      path: { id: 'schedule_id' }, readOnly: true,
      description: 'One schedule by id.',
      properties: { schedule_id: ID('Schedule') }, required: ['schedule_id'],
    }),
    def({
      name: 'schedule_update', title: 'Update a schedule', method: 'PATCH', route: 'schedules/[id]',
      path: { id: 'schedule_id' },
      description: 'Change a schedule (name, cron, timezone, enabled, options). Same body as PATCH /api/schedules/{id}.',
      properties: {
        schedule_id: ID('Schedule'), name: str('Name.'), widget_type: str('Widget type.'), schedule_kind: str('Schedule kind.'),
        server_id: str('Server id.'), resource_kind: str('Resource kind.', { enum: ['stack', 'container'] }), resource_name: str('Resource name.'),
        cron: str('Cron expression.'), timezone: str('IANA timezone.'),
        enabled: bool('Enabled.'), options: obj('Schedule options.'),
      },
      required: ['schedule_id'],
    }),
    def({
      name: 'schedule_delete', title: 'Delete a schedule', method: 'DELETE', route: 'schedules/[id]',
      path: { id: 'schedule_id' }, destructive: true,
      confirmText: 'Deleting a schedule stops future runs; its run history is removed.',
      description: 'Delete a schedule. Requires confirm: true.',
      properties: { schedule_id: ID('Schedule') }, required: ['schedule_id'],
    }),
    def({
      name: 'schedule_runs', title: 'Schedule run history', method: 'GET', route: 'schedules/[id]/runs',
      path: { id: 'schedule_id' }, query: ['limit', 'offset'], readOnly: true,
      description: 'A page of one schedule\'s run history, newest first.',
      properties: {
        schedule_id: ID('Schedule'), limit: int('Page size (default 25).', { minimum: 1, maximum: 100 }),
        offset: int('Rows to skip.', { minimum: 0 }),
      },
      required: ['schedule_id'],
    }),
    def({
      name: 'schedule_kinds', title: 'Schedule kinds', method: 'GET', route: 'schedules/kinds',
      query: ['server_id'], readOnly: true,
      description: 'The schedule kinds installed widgets declare that the caller may create on a server.',
      properties: { server_id: SERVER_ID }, required: ['server_id'],
    }),

    // ---- Notifications ---------------------------------------------------------------------------------------
    def({
      name: 'notification_create', title: 'Post a notification', method: 'POST', route: 'notifications',
      description: 'Post a notification by hand (Full access). Body: title, message, severity, server_id, link.',
      properties: {
        title: str('Title.', { minLength: 1, maxLength: 200 }), message: str('Message.'),
        severity: str('Severity.', { enum: ['info', 'success', 'warning', 'critical'] }),
        server_id: str('Optional server id.'), link: str('Optional link.'),
      },
      required: ['title'],
    }),
    def({
      name: 'notifications_mark_read', title: 'Mark notifications read', method: 'PATCH', route: 'notifications',
      description: 'Mark one notification read (pass id) or every visible notification read (leave id out).',
      properties: { id: str('Notification id (leave out for all).'), read: { type: 'boolean', const: true, description: 'Must be true.' } },
      required: ['read'],
    }),
    def({
      name: 'notification_update', title: 'Update a notification', method: 'PATCH', route: 'notifications/[id]',
      path: { id: 'notification_id' },
      description: 'Mark one notification read, or put a dismissed one back in the bell.',
      properties: {
        notification_id: ID('Notification'), read: { type: 'boolean', const: true, description: 'Mark it read.' },
        dismissed: { type: 'boolean', const: false, description: 'Restore a dismissed notification.' },
        restore: { type: 'boolean', const: true, description: 'Restore a dismissed notification.' },
      },
      required: ['notification_id'],
    }),
    def({
      name: 'notification_delete', title: 'Dismiss a notification', method: 'DELETE', route: 'notifications/[id]',
      path: { id: 'notification_id' }, destructive: true,
      confirmText: 'Dismissing a notification hides it for everyone in the bell.',
      description: 'Dismiss (hide) one notification for everyone. Operators and up. Requires confirm: true.',
      properties: { notification_id: ID('Notification') }, required: ['notification_id'],
    }),
    def({
      name: 'notification_channels_list', title: 'List notification channels', method: 'GET', route: 'notification-channels',
      readOnly: true,
      description: 'Notification channels (webhooks, email). Their configs hold credentials; Full access only.',
    }),
    def({
      name: 'notification_channel_create', title: 'Create a notification channel', method: 'POST', route: 'notification-channels',
      description: 'Create a notification channel. Full access only.',
      properties: {
        name: str('Name.', { minLength: 1, maxLength: 100 }), type: str('Channel type.', { minLength: 1 }),
        config: obj('Channel configuration.'), enabled: bool('Enabled.'),
      },
      required: ['name', 'type'],
    }),

    // ---- Alert rules -----------------------------------------------------------------------------------------
    def({
      name: 'alert_rules_list', title: 'List alert rules', method: 'GET', route: 'alert-rules',
      query: [{ arg: 'enabled', trueValue: 'true' }], readOnly: true,
      description: 'Alert rules for the servers the caller may see.',
      properties: { enabled: bool('Only enabled rules.') },
    }),
    def({
      name: 'alert_rule_create', title: 'Create an alert rule', method: 'POST', route: 'alert-rules',
      description: 'Create an alert rule. Full access only.',
      properties: {
        name: str('Rule name.', { minLength: 1, maxLength: 100 }), description: str('Description.'),
        metric: str('Metric id.'),
        condition: str('Comparison.', { enum: ['gt', 'gte', 'lt', 'lte'] }), threshold: { type: 'number', description: 'Threshold.' },
        server_id: str('Optional server id (omit for the whole fleet).'), severity: str('Severity.', { enum: ['info', 'warning', 'critical'] }),
        cooldown_sec: int('Cooldown seconds.', { minimum: 30 }), channels: arr('Channel ids.', { type: 'string' }),
        emails: arr('Email recipients.', { type: 'string' }), enabled: bool('Enabled.'),
      },
      required: ['name', 'metric', 'condition', 'threshold'],
    }),
    def({
      name: 'alert_rule_delete', title: 'Delete an alert rule (legacy)', method: 'DELETE', route: 'alert-rules',
      query: ['id'], destructive: true, confirmText: 'The alert rule stops evaluating.',
      description: 'Delete an alert rule by query id (legacy endpoint). Full access only. Requires confirm: true.',
      properties: { id: ID('Alert rule') }, required: ['id'],
    }),
    def({
      name: 'alert_rule_update', title: 'Update an alert rule', method: 'PATCH', route: 'alert-rules/[ruleId]',
      path: { ruleId: 'rule_id' },
      description: 'Update an alert rule. Full access only.',
      properties: {
        rule_id: ID('Alert rule'), enabled: bool('Enabled.'), threshold: { type: 'number', description: 'Threshold.' },
        name: str('Rule name.'), cooldown_sec: int('Cooldown seconds.', { minimum: 30 }),
        emails: arr('Email recipients.', { type: 'string' }),
      },
      required: ['rule_id'],
    }),
    def({
      name: 'alert_rule_delete_by_id', title: 'Delete an alert rule', method: 'DELETE', route: 'alert-rules/[ruleId]',
      path: { ruleId: 'rule_id' }, destructive: true, confirmText: 'The alert rule stops evaluating.',
      description: 'Delete one alert rule. Full access only. Requires confirm: true.',
      properties: { rule_id: ID('Alert rule') }, required: ['rule_id'],
    }),

    // ---- Access requests -------------------------------------------------------------------------------------
    def({
      name: 'access_requests_list', title: 'List access requests', method: 'GET', route: 'access-requests',
      query: [{ arg: 'mine', trueValue: '1' }, 'status', 'limit'], readOnly: true,
      description: 'Access requests the caller may see: their own, plus everyone\'s for people who can decide.',
      properties: {
        mine: bool('Only my requests.'), status: str('Filter by status.', { enum: ['pending', 'approved', 'denied', 'expired', 'cancelled', 'failed'] }),
        limit: int('Page size.', { minimum: 1, maximum: 500 }),
      },
    }),
    def({
      name: 'access_request_get', title: 'Get an access request', method: 'GET', route: 'access-requests/[id]',
      path: { id: 'request_id' }, query: ['wait'], readOnly: true,
      description: 'One access request. Pass wait (seconds, at most 50) to hold the call until it is decided.',
      properties: { request_id: ID('Request'), wait: int('Seconds to wait (at most 50).', { minimum: 1, maximum: 50 }) },
      required: ['request_id'],
    }),
    def({
      name: 'access_request_cancel', title: 'Cancel an access request', method: 'DELETE', route: 'access-requests/[id]',
      path: { id: 'request_id' },
      description: 'Cancel your own pending access request.',
      properties: { request_id: ID('Request') }, required: ['request_id'],
    }),
    def({
      name: 'access_request_decide', title: 'Decide an access request', method: 'POST', route: 'access-requests/[id]/decision',
      path: { id: 'request_id' }, destructive: true,
      confirmText: 'Approving a command or action runs it immediately.',
      description: 'Approve or deny an access request. Only a signed-in person who holds the permission can decide; high-risk ones need Full access.',
      properties: {
        request_id: ID('Request'), decision: str('Decision.', { enum: ['approve', 'deny'] }),
        note: str('Optional note for the requester.', { maxLength: 500 }),
      },
      required: ['request_id', 'decision'],
    }),

    // ---- Audit, permissions and groups -----------------------------------------------------------------------
    def({
      name: 'audit_logs_list', title: 'Audit log', method: 'GET', route: 'audit-logs',
      query: ['user_id', 'action', 'category', 'limit', 'offset'], readOnly: true,
      description: 'Audit log entries, newest first. Full access only.',
      properties: {
        user_id: str('Filter by user id.'), action: str('Filter by action.'), category: str('Filter by category.'),
        limit: int('Page size (default 100).', { minimum: 1, maximum: 500 }), offset: int('Rows to skip.', { minimum: 0 }),
      },
    }),
    def({
      name: 'permissions_list', title: 'List permissions', method: 'GET', route: 'permissions', readOnly: true,
      description: 'Every permission that can be granted. Full access only (signed-in).',
    }),
    def({
      name: 'permission_groups_list', title: 'List permission groups', method: 'GET', route: 'permission-groups',
      readOnly: true, description: 'Permission groups. Full access only (signed-in).',
    }),
    def({
      name: 'permission_group_create', title: 'Create a permission group', method: 'POST', route: 'permission-groups',
      description: 'Create a permission group. Full access only (signed-in).',
      properties: {
        name: str('Group name.', { minLength: 1, maxLength: 60 }), description: str('Description.'),
        grants: arr('Grants.', obj('A grant.')),
      },
      required: ['name'],
    }),
    def({
      name: 'permission_group_get', title: 'Get a permission group', method: 'GET', route: 'permission-groups/[groupId]',
      path: { groupId: 'group_id' }, readOnly: true,
      description: 'One permission group with its grants. Full access only (signed-in).',
      properties: { group_id: ID('Group') }, required: ['group_id'],
    }),
    def({
      name: 'permission_group_update', title: 'Update a permission group', method: 'PATCH', route: 'permission-groups/[groupId]',
      path: { groupId: 'group_id' },
      description: 'Change a permission group\'s name, description or grants. Full access only (signed-in).',
      properties: {
        group_id: ID('Group'), name: str('Group name.'), description: str('Description.'),
        grants: arr('Grants.', obj('A grant.')),
      },
      required: ['group_id'],
    }),
    def({
      name: 'permission_group_delete', title: 'Delete a permission group', method: 'DELETE', route: 'permission-groups/[groupId]',
      path: { groupId: 'group_id' }, destructive: true,
      confirmText: 'Deleting a permission group removes the grants it holds.',
      description: 'Delete a permission group. Full access only (signed-in). Requires confirm: true.',
      properties: { group_id: ID('Group') }, required: ['group_id'],
    }),
    def({
      name: 'server_groups_list', title: 'List server groups', method: 'GET', route: 'server-groups',
      readOnly: true, description: 'Server groups. Full access only (signed-in).',
    }),
    def({
      name: 'server_group_create', title: 'Create a server group', method: 'POST', route: 'server-groups',
      description: 'Create a server group. Full access only (signed-in).',
      properties: {
        name: str('Group name.', { minLength: 1, maxLength: 60 }), description: str('Description.'),
        server_ids: arr('Server ids.', { type: 'string' }),
      },
      required: ['name'],
    }),
    def({
      name: 'server_group_update', title: 'Update a server group', method: 'PATCH', route: 'server-groups/[groupId]',
      path: { groupId: 'group_id' },
      description: 'Change a server group\'s name, description or members. Full access only (signed-in).',
      properties: {
        group_id: ID('Group'), name: str('Group name.'), description: str('Description.'),
        server_ids: arr('Server ids.', { type: 'string' }),
      },
      required: ['group_id'],
    }),
    def({
      name: 'server_group_delete', title: 'Delete a server group', method: 'DELETE', route: 'server-groups/[groupId]',
      path: { groupId: 'group_id' }, destructive: true, confirmText: 'The group and its memberships are removed.',
      description: 'Delete a server group. Full access only (signed-in). Requires confirm: true.',
      properties: { group_id: ID('Group') }, required: ['group_id'],
    }),

    // ---- SSH keys --------------------------------------------------------------------------------------------
    def({
      name: 'ssh_keys_list', title: 'List SSH keys', method: 'GET', route: 'ssh-keys', readOnly: true,
      description: 'SSH keys stored by Bosun. Full access only.',
    }),
    def({
      name: 'ssh_key_create', title: 'Add an SSH key', method: 'POST', route: 'ssh-keys',
      description: 'Add an SSH key pair. Full access only.',
      properties: {
        name: str('Key name.', { minLength: 1, maxLength: 100 }), public_key: str('Public key.'),
        private_key: str('Private key.'), passphrase: str('Passphrase, if any.'),
      },
      required: ['name', 'public_key', 'private_key'],
    }),
    def({
      name: 'ssh_key_get', title: 'Get an SSH key', method: 'GET', route: 'ssh-keys/[keyId]',
      path: { keyId: 'key_id' }, readOnly: true,
      description: 'One SSH key\'s public details. Full access only.',
      properties: { key_id: ID('Key') }, required: ['key_id'],
    }),
    def({
      name: 'ssh_key_delete', title: 'Delete an SSH key', method: 'DELETE', route: 'ssh-keys/[keyId]',
      path: { keyId: 'key_id' }, destructive: true, confirmText: 'Servers using this key lose their access.',
      description: 'Delete an SSH key. Full access only. Requires confirm: true.',
      properties: { key_id: ID('Key') }, required: ['key_id'],
    }),
    def({
      name: 'ssh_key_generate', title: 'Generate an SSH key', method: 'POST', route: 'ssh-keys/generate',
      description: 'Generate a new SSH key pair. Full access only.',
      properties: { name: str('Key name.') },
    }),

    // ---- Users and API keys ----------------------------------------------------------------------------------
    def({
      name: 'users_list', title: 'List users', method: 'GET', route: 'users', readOnly: true,
      description: 'User accounts. Full access only (signed-in).',
    }),
    def({
      name: 'user_create', title: 'Create a user', method: 'POST', route: 'users',
      description: 'Create a user. Full access only (signed-in).',
      properties: {
        username: str('Username.', { minLength: 1, maxLength: 64 }), password: str('Password.'),
        role: str('Access level.', { enum: ['viewer', 'operator', 'admin'] }), display_name: str('Display name.'), email: str('Email.'),
      },
      required: ['username', 'password'],
    }),
    def({
      name: 'user_update', title: 'Update a user', method: 'PATCH', route: 'users/[userId]',
      path: { userId: 'user_id' },
      description: 'Change a user\'s name, email, role, password or disabled state. Full access only (signed-in).',
      properties: {
        user_id: ID('User'), display_name: str('Display name.'), email: str('Email.'), password: str('New password.'),
        role: str('Access level.', { enum: ['viewer', 'operator', 'admin'] }), disabled: bool('Disable the account.'),
      },
      required: ['user_id'],
    }),
    def({
      name: 'user_delete', title: 'Delete a user', method: 'DELETE', route: 'users/[userId]',
      path: { userId: 'user_id' }, destructive: true, confirmText: 'The account and its sessions are removed.',
      description: 'Delete a user. Full access only (signed-in). Requires confirm: true.',
      properties: { user_id: ID('User') }, required: ['user_id'],
    }),
    def({
      name: 'user_set_groups', title: 'Set a user\'s permission groups', method: 'PUT', route: 'users/[userId]/groups',
      path: { userId: 'user_id' },
      description: 'Replace a user\'s permission groups. Full access only (signed-in).',
      properties: { user_id: ID('User'), group_ids: arr('Group ids.', { type: 'string' }) },
      required: ['user_id', 'group_ids'],
    }),
    def({
      name: 'api_keys_list', title: 'List API keys', method: 'GET', route: 'api-keys', readOnly: true,
      description: 'API keys. Full access only (signed-in).',
    }),
    def({
      name: 'api_key_create', title: 'Create an API key', method: 'POST', route: 'api-keys',
      description: 'Create an API key. Full access only (signed-in). The secret is returned once.',
      properties: {
        name: str('Key name.', { minLength: 1, maxLength: 100 }), role: str('Access level.', { enum: ['viewer', 'operator', 'admin'] }),
        expires_in_days: int('Days until it expires.', { minimum: 1 }),
      },
      required: ['name', 'role'],
    }),
    def({
      name: 'api_key_revoke', title: 'Revoke an API key', method: 'PATCH', route: 'api-keys/[keyId]',
      path: { keyId: 'key_id' }, destructive: true, confirmText: 'The key stops working immediately.',
      description: 'Revoke an API key. Full access only (signed-in). Requires confirm: true.',
      properties: { key_id: ID('Key'), revoked: { type: 'boolean', const: true, description: 'Must be true.' } },
      required: ['key_id', 'revoked'],
    }),
    def({
      name: 'api_key_delete', title: 'Delete an API key', method: 'DELETE', route: 'api-keys/[keyId]',
      path: { keyId: 'key_id' }, destructive: true, confirmText: 'The key is removed permanently.',
      description: 'Delete an API key. Full access only (signed-in). Requires confirm: true.',
      properties: { key_id: ID('Key') }, required: ['key_id'],
    }),
    def({
      name: 'api_key_set_groups', title: 'Set an API key\'s permission groups', method: 'PUT', route: 'api-keys/[keyId]/groups',
      path: { keyId: 'key_id' },
      description: 'Replace an API key\'s permission groups. Full access only (signed-in).',
      properties: { key_id: ID('Key'), group_ids: arr('Group ids.', { type: 'string' }) },
      required: ['key_id', 'group_ids'],
    }),

    // ---- Dashboards ------------------------------------------------------------------------------------------
    def({
      name: 'dashboards_list', title: 'List dashboards', method: 'GET', route: 'dashboards',
      query: ['type'], readOnly: true,
      description: 'Dashboards the caller may see.',
      properties: { type: str('Filter by dashboard type.', { enum: ['home', 'server', 'custom'] }) },
    }),
    def({
      name: 'dashboard_create', title: 'Create a dashboard', method: 'POST', route: 'dashboards',
      description: 'Create a custom dashboard. Needs dashboards.edit.',
      properties: { name: str('Name.', { minLength: 1 }), icon: str('Icon name.') },
      required: ['name'],
    }),
    def({
      name: 'dashboards_reorder', title: 'Reorder dashboards', method: 'PATCH', route: 'dashboards',
      description: 'Reorder custom dashboards. Needs dashboards.edit.',
      properties: { order: arr('Dashboard ids, first shown first.', { type: 'string' }, { minItems: 1 }) },
      required: ['order'],
    }),
    def({
      name: 'dashboard_get', title: 'Get a dashboard', method: 'GET', route: 'dashboards/[dashboardId]',
      path: { dashboardId: 'dashboard_id' }, readOnly: true,
      description: 'One dashboard with its widgets.',
      properties: { dashboard_id: ID('Dashboard') }, required: ['dashboard_id'],
    }),
    def({
      name: 'dashboard_update', title: 'Update a dashboard', method: 'PATCH', route: 'dashboards/[dashboardId]',
      path: { dashboardId: 'dashboard_id' },
      description: 'Rename or re-icon a custom dashboard. Needs dashboards.edit.',
      properties: {
        dashboard_id: ID('Dashboard'), name: str('Name.'), icon: str('Icon name.'), sort_order: int('Sort order.'),
      },
      required: ['dashboard_id'],
    }),
    def({
      name: 'dashboard_delete', title: 'Delete a dashboard', method: 'DELETE', route: 'dashboards/[dashboardId]',
      path: { dashboardId: 'dashboard_id' }, destructive: true, confirmText: 'The dashboard and its widgets are removed.',
      description: 'Delete a custom dashboard. Needs dashboards.edit. Requires confirm: true.',
      properties: { dashboard_id: ID('Dashboard') }, required: ['dashboard_id'],
    }),
    def({
      name: 'dashboard_layout_update', title: 'Update a dashboard layout', method: 'PATCH', route: 'dashboards/[dashboardId]/layout',
      path: { dashboardId: 'dashboard_id' },
      description: 'Save widget positions for a breakpoint. Needs dashboards.edit.',
      properties: {
        dashboard_id: ID('Dashboard'), breakpoint: str('Breakpoint.', { enum: ['xxl', 'xl', 'lg', 'md', 'sm', 'xs', 'xxs'] }),
        layout: arr('Widget rects.', obj('A rect.', { properties: { widgetId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } } })),
        mode: str('Update mode.', { enum: ['edit', 'everywhere', 'reset'] }),
      },
      required: ['dashboard_id'],
    }),
    def({
      name: 'dashboard_widgets_list', title: 'List a dashboard\'s widgets', method: 'GET', route: 'dashboards/[dashboardId]/widgets',
      path: { dashboardId: 'dashboard_id' }, readOnly: true,
      description: 'Widgets on one dashboard.',
      properties: { dashboard_id: ID('Dashboard') }, required: ['dashboard_id'],
    }),
    def({
      name: 'dashboard_widget_add', title: 'Add a widget to a dashboard', method: 'POST', route: 'dashboards/[dashboardId]/widgets',
      path: { dashboardId: 'dashboard_id' },
      description: 'Add a widget instance to a dashboard. Needs dashboards.edit and the widget\'s data permission.',
      properties: {
        dashboard_id: ID('Dashboard'), widget_type: str('Widget type.'), server_id: str('Server id.'),
        config: obj('Widget config.'), title_override: str('Title.'), grid_x: int('X.'), grid_y: int('Y.'), grid_w: int('Width.'), grid_h: int('Height.'),
      },
      required: ['dashboard_id', 'widget_type'],
    }),

    // ---- Widget instances ------------------------------------------------------------------------------------
    def({
      name: 'widget_instances_list', title: 'List widget instances', method: 'GET', route: 'widgets/instances',
      readOnly: true, description: 'Widget instances the caller may see.',
    }),
    def({
      name: 'widget_screens_list', title: 'List widget screens', method: 'GET', route: 'widgets/screens',
      readOnly: true, description: 'Screens declared by installed widget packages.',
    }),
    def({
      name: 'widget_get', title: 'Get a widget', method: 'GET', route: 'widgets/[widgetId]',
      path: { widgetId: 'widget_id' }, readOnly: true,
      description: 'One widget instance.',
      properties: { widget_id: ID('Widget') }, required: ['widget_id'],
    }),
    def({
      name: 'widget_update', title: 'Update a widget', method: 'PATCH', route: 'widgets/[widgetId]',
      path: { widgetId: 'widget_id' },
      description: 'Change a widget\'s config, title or size. Needs dashboards.edit.',
      properties: {
        widget_id: ID('Widget'), config: obj('Widget config.'), title_override: str('Title.'),
        grid_x: int('X.'), grid_y: int('Y.'), grid_w: int('Width.'), grid_h: int('Height.'),
      },
      required: ['widget_id'],
    }),
    def({
      name: 'widget_delete', title: 'Delete a widget', method: 'DELETE', route: 'widgets/[widgetId]',
      path: { widgetId: 'widget_id' }, destructive: true, confirmText: 'The widget is removed from its dashboard.',
      description: 'Delete a widget instance. Needs dashboards.edit. Requires confirm: true.',
      properties: { widget_id: ID('Widget') }, required: ['widget_id'],
    }),
    def({
      name: 'widget_settings_get', title: 'Get widget settings', method: 'GET', route: 'widgets/[widgetId]/settings',
      path: { widgetId: 'widget_id' }, readOnly: true,
      description: 'A widget\'s settings, including its config schema.',
      properties: { widget_id: ID('Widget') }, required: ['widget_id'],
    }),
    def({
      name: 'widget_settings_update', title: 'Update widget settings', method: 'PUT', route: 'widgets/[widgetId]/settings',
      path: { widgetId: 'widget_id' },
      description: 'Save a widget\'s settings. Needs dashboards.edit.',
      properties: {
        widget_id: ID('Widget'), config: obj('Widget config.'), display_name: str('Display name.'),
        poll_interval_sec: int('Server poll interval (Full access).', { minimum: 5, maximum: 3600 }),
        enabled: bool('Server polling (Full access).'), grid_w: int('Width.'), grid_h: int('Height.'),
      },
      required: ['widget_id'],
    }),
    def({
      name: 'widget_data_get', title: 'Get widget data', method: 'GET', route: 'widgets/[widgetId]/data',
      path: { widgetId: 'widget_id' }, query: [{ arg: 'force', trueValue: 'true' }], readOnly: true,
      description: 'The data a widget renders. Pass force=true to refresh (needs servers.refresh).',
      properties: { widget_id: ID('Widget'), force: bool('Force a refresh.') },
      required: ['widget_id'],
    }),

    // ---- Widget definitions and runtime ----------------------------------------------------------------------
    def({
      name: 'widget_definitions_list', title: 'List widget definitions', method: 'GET', route: 'widget-definitions',
      query: ['serverId'], readOnly: true,
      description: 'Built-in and custom widget definitions (optionally for one server\'s platform).',
      properties: { serverId: str('Optional server id.') },
    }),
    def({
      name: 'widget_definition_get', title: 'Get a widget definition', method: 'GET', route: 'widget-definitions/[type]',
      path: { type: 'widget_type' }, readOnly: true,
      description: 'One custom widget definition.',
      properties: { widget_type: ID('Widget type') }, required: ['widget_type'],
    }),
    def({
      name: 'widget_definition_update', title: 'Update a widget definition', method: 'PATCH', route: 'widget-definitions/[type]',
      path: { type: 'widget_type' },
      description: 'Change a custom widget definition. Full access only.',
      properties: { widget_type: ID('Widget type') }, required: ['widget_type'],
    }),
    def({
      name: 'widget_definition_delete', title: 'Delete a widget definition', method: 'DELETE', route: 'widget-definitions/[type]',
      path: { type: 'widget_type' }, destructive: true, confirmText: 'The custom widget type is removed.',
      description: 'Delete a custom widget definition. Full access only. Requires confirm: true.',
      properties: { widget_type: ID('Widget type') }, required: ['widget_type'],
    }),
    def({
      name: 'widget_runtime_get', title: 'Get a widget runtime spec', method: 'GET', route: 'widget-runtime/[type]',
      path: { type: 'widget_type' }, readOnly: true,
      description: 'The public runtime spec of a package widget (how to draw it and its actions).',
      properties: { widget_type: ID('Widget type') }, required: ['widget_type'],
    }),

    // ---- Widget jobs -----------------------------------------------------------------------------------------
    def({
      name: 'widget_jobs_list', title: 'List widget jobs', method: 'GET', route: 'widget-jobs',
      readOnly: true, description: 'Recent widget jobs (tasks) the caller may see.',
    }),
    def({
      name: 'widget_job_get', title: 'Get a widget job', method: 'GET', route: 'widget-jobs/[jobId]',
      path: { jobId: 'job_id' }, readOnly: true,
      description: 'One widget job.',
      properties: { job_id: ID('Job') }, required: ['job_id'],
    }),
    def({
      name: 'widget_job_update', title: 'Update a widget job', method: 'PATCH', route: 'widget-jobs/[jobId]',
      path: { jobId: 'job_id' },
      description: 'Dismiss or restore a finished widget job in the caller\'s task list.',
      properties: { job_id: ID('Job'), dismissed: bool('Dismiss it.') },
      required: ['job_id'],
    }),
    def({
      name: 'widget_job_origin', title: 'Widget job origin', method: 'GET', route: 'widget-jobs/[jobId]/origin',
      path: { jobId: 'job_id' }, readOnly: true,
      description: 'Which widget, dashboard and screen started a widget job.',
      properties: { job_id: ID('Job') }, required: ['job_id'],
    }),
    def({
      name: 'widget_job_latest', title: 'Widget job for a widget', method: 'GET', route: 'servers/[serverId]/widget-jobs/[widgetType]',
      path: { serverId: 'server_id', widgetType: 'widget_type' }, query: ['id'], readOnly: true,
      description: 'The newest job (running or finished) for one widget on a server, or ?id=... for a specific job. Needs the widget\'s data permission.',
      properties: { server_id: SERVER_ID, widget_type: ID('Widget type'), id: ID('Job') },
      required: ['server_id', 'widget_type'],
    }),
    def({
      name: 'widget_job_cancel', title: 'Cancel a widget job', method: 'POST', route: 'servers/[serverId]/widget-jobs/[widgetType]/[jobId]/cancel',
      path: { serverId: 'server_id', widgetType: 'widget_type', jobId: 'job_id' }, destructive: true,
      confirmText: 'Stopping the job may leave the action half done.',
      description: 'Cancel a running widget job. Whoever started it may cancel it; anyone else needs the action\'s permission. Requires confirm: true.',
      properties: { server_id: SERVER_ID, widget_type: ID('Widget type'), job_id: ID('Job') },
      required: ['server_id', 'widget_type', 'job_id'],
    }),

    // ---- Widget packages -------------------------------------------------------------------------------------
    def({
      name: 'widget_packages_list', title: 'List widget packages', method: 'GET', route: 'widget-packages',
      readOnly: true, description: 'Installed widget packages and where packages are listed from. Full access (signed-in).',
    }),
    def({
      name: 'widget_package_delete', title: 'Remove a widget package', method: 'DELETE', route: 'widget-packages/[id]',
      path: { id: 'package_id' }, query: [{ arg: 'remove_widgets', trueValue: '1' }], destructive: true,
      confirmText: 'The package and its code are removed; pass remove_widgets=true to remove its widgets too.',
      description: 'Remove an installed widget package. Full access (signed-in). Requires confirm: true.',
      properties: { package_id: ID('Package'), remove_widgets: bool('Remove its widgets too.') },
      required: ['package_id'],
    }),
    def({
      name: 'widget_package_export', title: 'Export a widget package', method: 'GET', route: 'widget-packages/[id]/export',
      path: { id: 'package_id' }, readOnly: true, binary: 'raw',
      description: 'Export an installed package as a zip, returned as base64 text (content_base64). Full access (signed-in).',
      properties: { package_id: ID('Package') }, required: ['package_id'],
    }),
    def({
      name: 'widget_package_secrets_list', title: 'List a package\'s secrets', method: 'GET', route: 'widget-packages/[id]/secrets',
      path: { id: 'package_id' }, readOnly: true,
      description: 'The secrets a widget package declares and whether each is set. Values are never returned. Full access (signed-in).',
      properties: { package_id: ID('Package') }, required: ['package_id'],
    }),
    def({
      name: 'widget_package_secret_set', title: 'Set a package secret', method: 'PUT', route: 'widget-packages/[id]/secrets',
      path: { id: 'package_id' },
      description: 'Set one of a widget package\'s declared secrets. The value is stored encrypted and is never returned by any tool. Full access (signed-in).',
      properties: {
        package_id: ID('Package'), id: str('Secret id declared by the package.', { minLength: 1 }),
        value: str('Secret value. It is never echoed back.'),
      },
      required: ['package_id', 'id', 'value'],
    }),
    def({
      name: 'widget_package_secret_delete', title: 'Delete a package secret', method: 'DELETE', route: 'widget-packages/[id]/secrets',
      path: { id: 'package_id' }, query: ['id'], destructive: true,
      confirmText: 'The stored secret is removed.',
      description: 'Remove one of a widget package\'s declared secrets. Full access (signed-in). Requires confirm: true.',
      properties: { package_id: ID('Package'), id: str('Secret id declared by the package.', { minLength: 1 }) },
      required: ['package_id', 'id'],
    }),
    def({
      name: 'widget_packages_available', title: 'List available widget packages', method: 'GET', route: 'widget-packages/available',
      query: [{ arg: 'refresh', trueValue: '1' }], readOnly: true,
      description: 'Packages offered by the configured branch, with install/upgrade state. Full access (signed-in).',
      properties: { refresh: bool('Skip the 5-minute cache.') },
    }),
    def({
      name: 'widget_package_import', title: 'Import a widget package', method: 'POST', route: 'widget-packages/import',
      query: [{ arg: 'replace', trueValue: '1' }, { arg: 'dry_run', trueValue: '1' }], binary: 'raw', destructive: true,
      confirmText: 'Importing installs the package\'s code and widgets on this Bosun.',
      description: 'Import a widget package zip. Send the zip as base64 in content_base64. Full access (signed-in). Requires confirm: true.',
      properties: {
        content_base64: str('The package zip, base64-encoded.', { minLength: 1 }), replace: bool('Replace an installed version.'),
        dry_run: bool('Validate and review without installing.'),
      },
      required: ['content_base64'],
    }),
    def({
      name: 'widget_package_install', title: 'Install a widget package', method: 'POST', route: 'widget-packages/install',
      destructive: true, confirmText: 'Installing runs the package\'s code on this Bosun.',
      description: 'Install or upgrade a package from the configured branch, after reviewing it. Full access (signed-in). Requires confirm: true.',
      properties: {
        id: str('Package id.'), version: str('Reviewed version.'), manifestHash: str('Reviewed manifest hash (64 hex).'),
      },
      required: ['id', 'version', 'manifestHash'],
    }),
    def({
      name: 'widget_packages_settings_update', title: 'Set the widget package source', method: 'PUT', route: 'widget-packages/settings',
      description: 'Choose the branch packages are listed from. Full access (signed-in).',
      properties: { ref: str('Branch.', { enum: ['main', 'dev'] }) }, required: ['ref'],
    }),

    // ---- Settings, system, database and cluster --------------------------------------------------------------
    def({
      name: 'smtp_settings_get', title: 'Get SMTP settings', method: 'GET', route: 'settings/smtp',
      readOnly: true, description: 'SMTP settings (the password is not returned). Full access only.',
    }),
    def({
      name: 'smtp_settings_update', title: 'Update SMTP settings', method: 'PUT', route: 'settings/smtp',
      description: 'Update SMTP settings. Full access only.',
      properties: {
        enabled: bool('Enable email.'), host: str('SMTP host.'), port: int('Port.', { minimum: 1, maximum: 65535 }),
        security: str('Connection security.', { enum: ['none', 'starttls', 'tls'] }),
        user: str('SMTP username.'), password: str('Password (never returned).'), clear_password: bool('Remove the stored password.'),
        from: str('From address.'), app_url: str('App URL used in links.'),
      },
    }),
    def({
      name: 'smtp_test', title: 'Send a test email', method: 'POST', route: 'settings/smtp/test',
      openWorld: true, description: 'Send a test email to verify SMTP settings. Full access only.',
      properties: { to: str('Recipient address.') },
    }),
    def({
      name: 'wol_settings_get', title: 'Get Wake-on-LAN settings', method: 'GET', route: 'settings/wol',
      readOnly: true, description: 'Wake-on-LAN settings. Full access only.',
    }),
    def({
      name: 'wol_settings_update', title: 'Update Wake-on-LAN settings', method: 'PUT', route: 'settings/wol',
      description: 'Update where magic packets are sent from. Full access only.',
      properties: {
        sender: str('Sender mode.', { enum: ['auto', 'local_server', 'container'] }),
        local_server_id: str('Local server id.'), node_host_server_id: str('Node host server id.'),
      },
    }),
    def({
      name: 'system_health', title: 'System health', method: 'GET', route: 'system/health',
      readOnly: true, description: 'Bosun host health: disk, memory, database and services.',
    }),
    def({
      name: 'update_config', title: 'Configure updates', method: 'PUT', route: 'system/update',
      description: 'Change the update channel, image or web port. Full access (signed-in).',
      properties: {
        image: str('Image.'), channel: str('Channel.'), web_port: int('Web port.', { minimum: 1, maximum: 65535 }),
      },
    }),
    def({
      name: 'update_action', title: 'Check, start or roll back an update', method: 'POST', route: 'system/update',
      destructive: true, keepConfirm: true,
      confirmText: 'Starting a rollout restarts Bosun nodes; a rollback replaces the running version.',
      description: 'Check for an update, start a rollout or roll back. Full access (signed-in). Requires confirm: true (check ignores it).',
      properties: {
        action: str('What to do.', { enum: ['check', 'start', 'rollback'] }), target: str('Target commit or version for a rollout.'),
      },
      required: ['action'],
    }),
    def({
      name: 'cluster_status', title: 'Cluster status', method: 'GET', route: 'cluster/status',
      readOnly: true, description: 'Cluster status: nodes, leader and reachability.',
    }),
    def({
      name: 'cluster_nodes', title: 'Cluster nodes', method: 'GET', route: 'cluster/nodes',
      readOnly: true, description: 'Cluster nodes.',
    }),
    def({
      name: 'cluster_config', title: 'Cluster configuration', method: 'GET', route: 'cluster/config',
      readOnly: true, description: 'Cluster configuration. Full access (signed-in).',
    }),
    def({
      name: 'cluster_action', title: 'Change the cluster', method: 'POST', route: 'cluster/actions',
      destructive: true, keepConfirm: true, openWorld: true,
      confirmText: 'Enabling clustering or removing a node changes which database nodes serve requests.',
      description: 'Enable clustering, add or remove a node. action and confirm: true required. Full access (signed-in).',
      properties: {
        action: str('Action.', { enum: ['enable', 'add_node', 'remove_node'] }), adv_host: str('Advertise host.'),
        node_id: str('Node id.'), join_token: str('Join token.'),
      },
      required: ['action'],
    }),
    def({
      name: 'db_health', title: 'Database health', method: 'GET', route: 'db/health',
      readOnly: true, description: 'Database health and replication state.',
    }),
    def({
      name: 'db_settings_get', title: 'Get database settings', method: 'GET', route: 'db/settings',
      readOnly: true, description: 'Editable database and application settings.',
    }),
    def({
      name: 'db_settings_update', title: 'Update database settings', method: 'PUT', route: 'db/settings',
      bodyRoot: 'settings',
      description: 'Update editable application settings (the settings object is sent as the body). Full access only.',
      properties: { settings: obj('Map of setting key to value.') }, required: ['settings'],
    }),
    def({
      name: 'db_export_options', title: 'Database export options', method: 'GET', route: 'db/export/options',
      readOnly: true, description: 'Available backup formats, tables and schema versions.',
    }),
    def({
      name: 'db_export', title: 'Export the database', method: 'GET', route: 'db/export',
      query: ['format', 'tables', { arg: 'includeSecrets', trueValue: 'true' }, { arg: 'excludeLarge', trueValue: 'true' }], readOnly: true, binary: 'raw',
      description: 'Export a database backup, returned as base64 text (content_base64) with its content type. includeSecrets=true includes credentials and keys, so treat the result as sensitive. Full access (signed-in).',
      properties: {
        format: str('Format.', { enum: ['json', 'sqlite', 'sql'] }), tables: str('Comma-separated table names (JSON only).'),
        includeSecrets: bool('Include secrets (JSON only).'), excludeLarge: bool('Exclude large tables.'),
      },
      required: ['format'],
    }),
    def({
      name: 'db_import', title: 'Import a database backup', method: 'POST', route: 'db/import',
      binary: 'form-file', destructive: true,
      confirmText: 'Restoring a backup can rewrite users, keys and every other table.',
      description: 'Restore a backup from base64 content (content_base64), as a multipart upload. replace=true is required for sqlite/sql. Full access (signed-in). Requires confirm: true.',
      properties: {
        content_base64: str('The backup file, base64-encoded.', { minLength: 1 }), filename: str('File name (optional).'),
        replace: bool('Clear each table first (required for sqlite/sql).'),
      },
      required: ['content_base64'],
    }),

    // ---- Metrics ---------------------------------------------------------------------------------------------
    def({
      name: 'metrics_history', title: 'Metric history', method: 'GET', route: 'metrics',
      query: ['serverId', 'metrics', 'range'], readOnly: true,
      description: 'Downsampled metric history for one server. Without metrics it lists the metrics that have data.',
      properties: {
        serverId: SERVER_ID, metrics: str('Comma-separated metric ids.'), range: str('Range, e.g. 1h, 24h, 7d, 30d.'),
      },
      required: ['serverId'],
    }),

    // ---- Custom widgets --------------------------------------------------------------------------------------
    def({
      name: 'custom_widgets_list', title: 'List custom widgets', method: 'GET', route: 'custom-widgets',
      readOnly: true, description: 'Custom widget definitions.',
    }),
  ];
}
