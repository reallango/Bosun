/**
 * What an admin should see before installing a package: every command and script it can run, as which
 * account, the hosts it may contact, and which permissions it adds. A package's commands run on the admin's hosts, so the
 * management page shows this and asks for a confirmation first. Pure.
 */
import crypto from 'crypto';
import type { PackageManifest, PackageFiles } from '@/lib/widgets/package-manifest';
import type { ScriptSpec } from '@/lib/widgets/runtime/spec-v2';

export interface ReviewCommand {
  /** What triggers it: "data" (runs when the widget refreshes) or the action label. */
  what: string;
  actionId?: string;
  permission?: string;
  /** `terminal`: opens the web terminal (the person types their own login there). */
  as: 'service' | 'shell' | 'terminal';
  command: string;
  windowsCommand?: string;
  confirm: boolean;
}

export interface ReviewScriptFile {
  platform: 'linux' | 'windows';
  file: string;
  /** SHA-256 of the file, when the files are at hand (an uploaded package). */
  sha256?: string;
  /** The text of the script (shortened), when the files are at hand. */
  text?: string;
  truncated?: boolean;
}

export interface ReviewScript {
  id: string;
  as: 'service' | 'shell';
  timeoutSec: number;
  params: string[];
  files: ReviewScriptFile[];
  /** What uses it: the widget's data, its state probe, or the actions that name it. */
  usedBy: string[];
}

export interface PackageReview {
  widgets: { type: string; name: string; dataSource: 'snapshot' | 'command' | null; commands: ReviewCommand[]; scripts: ReviewScript[] }[];
  permissions: { id: string; label: string; risk: string; defaultLevel: string }[];
  /** Hosts the package's lookups may contact over https. */
  network: string[];
  /** True when something runs as the privileged service account (unrestricted sudo). */
  runsAsService: boolean;
  /** Commands and scripts that can run on a host; the confirmation is asked when this is not zero. */
  commandCount: number;
}

const MAX_TEXT = 20_000;

function scriptFiles(s: ScriptSpec, files?: PackageFiles): ReviewScriptFile[] {
  const out: ReviewScriptFile[] = [];
  for (const platform of ['linux', 'windows'] as const) {
    const file = s[platform];
    if (!file) continue;
    const entry: ReviewScriptFile = { platform, file };
    const content = files?.[file];
    if (typeof content === 'string') {
      entry.sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      entry.text = content.slice(0, MAX_TEXT);
      if (content.length > MAX_TEXT) entry.truncated = true;
    }
    out.push(entry);
  }
  return out;
}

export function reviewPackage(m: PackageManifest, files?: PackageFiles): PackageReview {
  const widgets = m.widgets.map(w => {
    const commands: ReviewCommand[] = [];
    const spec = w.spec;
    const usedBy = new Map<string, string[]>();
    const use = (script: string, by: string) => usedBy.set(script, [...(usedBy.get(script) ?? []), by]);
    if (spec?.data.source === 'command') {
      if (spec.data.script) {
        use(spec.data.script, 'the widget data (runs when it refreshes)');
        commands.push({ what: 'data (runs when the widget refreshes)', as: spec.data.as, command: `script "${spec.data.script}"`, confirm: false, ...(spec.data.permission ? { permission: spec.data.permission } : {}) });
      } else {
        commands.push({ what: 'data (runs when the widget refreshes)', as: spec.data.as, command: spec.data.command, ...(spec.data.windowsCommand ? { windowsCommand: spec.data.windowsCommand } : {}), confirm: false, ...(spec.data.permission ? { permission: spec.data.permission } : {}) });
      }
    }
    if (spec?.state) {
      use(spec.state.script, 'the state check (runs in the background on every host with this widget)');
      commands.push({ what: 'state check (runs in the background)', as: spec.scripts?.[spec.state.script]?.as ?? 'service', command: `script "${spec.state.script}"`, confirm: false });
    }
    for (const a of spec?.actions ?? []) {
      if (a.kind === 'terminal') {
        commands.push({ what: a.label, actionId: a.id, permission: a.permission, as: 'terminal', command: `Interactive shell in a container: in the web UI the terminal asks for your own login (Full access only); for API keys holding this permission it hands out an API terminal token for ANY container of the host (a fixed docker exec as the service account, refused for containers that could reach the host)`, confirm: false });
        continue;
      }
      if (a.kind === 'script') {
        const names = (a.variants ?? []).map(v => v.script);
        for (const n of names) use(n, `the action "${a.label}"`);
        commands.push({ what: a.label, actionId: a.id, permission: a.permission, as: a.as, command: `script ${Array.from(new Set(names)).map(n => `"${n}"`).join(', ')}`, confirm: !!a.confirm });
        continue;
      }
      commands.push({ what: a.label, actionId: a.id, permission: a.permission, as: a.as, command: a.command, ...(a.windowsCommand ? { windowsCommand: a.windowsCommand } : {}), confirm: !!a.confirm });
    }
    const scripts: ReviewScript[] = Object.entries(spec?.scripts ?? {}).map(([id, s]) => ({
      id, as: s.as, timeoutSec: s.timeoutSec, params: Object.keys(s.params), files: scriptFiles(s, files), usedBy: usedBy.get(id) ?? [],
    }));
    return { type: w.type, name: String(w.columns.display_name ?? w.type), dataSource: spec ? spec.data.source : null, commands, scripts };
  });
  const all = widgets.flatMap(w => w.commands);
  const scriptCount = widgets.reduce((n, w) => n + w.scripts.length, 0);
  return {
    widgets,
    permissions: m.permissions.map(p => ({ id: p.id, label: p.label, risk: p.risk, defaultLevel: p.defaultLevel })),
    network: m.network ?? [],
    runsAsService: all.some(c => c.as === 'service') || widgets.some(w => w.scripts.some(s => s.as === 'service')),
    commandCount: all.length + scriptCount,
  };
}
