/**
 * What an admin should see before installing a package: every command it can run, as which
 * account, and which permissions it adds. A package's commands run on the admin's hosts, so the
 * management page shows this and asks for a confirmation first. Pure.
 */
import type { PackageManifest } from '@/lib/widgets/package-manifest';

export interface ReviewCommand {
  /** What triggers it: "data" (runs when the widget refreshes) or the action label. */
  what: string;
  actionId?: string;
  permission?: string;
  as: 'service' | 'shell';
  command: string;
  windowsCommand?: string;
  confirm: boolean;
}

export interface PackageReview {
  widgets: { type: string; name: string; dataSource: 'snapshot' | 'command' | null; commands: ReviewCommand[] }[];
  permissions: { id: string; label: string; risk: string; defaultLevel: string }[];
  /** True when something runs as the privileged service account (unrestricted sudo). */
  runsAsService: boolean;
  commandCount: number;
}

export function reviewPackage(m: PackageManifest): PackageReview {
  const widgets = m.widgets.map(w => {
    const commands: ReviewCommand[] = [];
    const spec = w.spec;
    if (spec?.data.source === 'command') {
      commands.push({ what: 'data (runs when the widget refreshes)', as: spec.data.as, command: spec.data.command, ...(spec.data.windowsCommand ? { windowsCommand: spec.data.windowsCommand } : {}), confirm: false, ...(spec.data.permission ? { permission: spec.data.permission } : {}) });
    }
    for (const a of spec?.actions ?? []) {
      commands.push({ what: a.label, actionId: a.id, permission: a.permission, as: a.as, command: a.command, ...(a.windowsCommand ? { windowsCommand: a.windowsCommand } : {}), confirm: !!a.confirm });
    }
    return { type: w.type, name: String(w.columns.display_name ?? w.type), dataSource: spec ? spec.data.source : null, commands };
  });
  const all = widgets.flatMap(w => w.commands);
  return {
    widgets,
    permissions: m.permissions.map(p => ({ id: p.id, label: p.label, risk: p.risk, defaultLevel: p.defaultLevel })),
    runsAsService: all.some(c => c.as === 'service'),
    commandCount: all.length,
  };
}
