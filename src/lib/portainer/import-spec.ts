/**
 * Turning a stack another tool runs into what Bosun's stack deployment takes (name, compose text, .env, or a git source).
 * Pure: the import route gathers the inputs.
 */

export interface DeploySource {
  source: 'editor' | 'git';
  yaml: string;
  env: string;
  repo: string;
  branch: string;
  file: string;
  notes: string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._/-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const FILE = /^[A-Za-z0-9._/-]{1,200}$/;

/** Portainer's environment list as .env lines; names or values .env cannot hold are left out with a note. */
export function envText(env: { name?: unknown; value?: unknown }[] | null | undefined, notes: string[]): string {
  const lines: string[] = [];
  for (const e of env ?? []) {
    const name = String(e?.name ?? '');
    const value = String(e?.value ?? '');
    if (!ENV_NAME.test(name)) { notes.push(`Left out the variable "${name.slice(0, 40)}" (not a valid name)`); continue; }
    if (/[\r\n]/.test(value)) { notes.push(`Left out ${name}: its value has a line break, which .env cannot hold`); continue; }
    lines.push(`${name}=${value}`);
  }
  if (lines.length > 200) { notes.push(`Only the first 200 of ${lines.length} variables fit`); lines.length = 200; }
  const text = lines.join('\n');
  return text ? `${text}\n` : '';
}

/** A Portainer git stack as Bosun's git source, or null when it cannot be one (then the compose file is copied instead). */
export function gitSourceOf(git: { URL?: unknown; ReferenceName?: unknown; ConfigFilePath?: unknown } | null | undefined, notes: string[]): { repo: string; branch: string; file: string } | null {
  if (!git?.URL) return null;
  const repo = String(git.URL).replace(/\.git$/, '');
  const branch = String(git.ReferenceName ?? '').replace(/^refs\/heads\//, '');
  const file = String(git.ConfigFilePath ?? '').replace(/^\.?\//, '');
  if (!REPO.test(repo)) { notes.push(`The repository ${repo.slice(0, 80)} is not an https address Bosun can fetch; the compose file is copied instead`); return null; }
  if (!BRANCH.test(branch) || branch.includes('..')) { notes.push(`The git reference "${branch.slice(0, 60)}" is not a branch; the compose file is copied instead`); return null; }
  if (!FILE.test(file) || file.includes('..')) { notes.push(`The compose path "${file.slice(0, 80)}" cannot be used; the compose file is copied instead`); return null; }
  return { repo, branch, file };
}

/**
 * Portainer writes the stack's variables to "stack.env" next to the compose file and some files load it with `env_file:`.
 * Bosun keeps them in ".env" in the stack folder, so a copied compose file is pointed there.
 */
export function adaptCopiedCompose(yaml: string, notes: string[]): string {
  let out = yaml;
  if (/(^|[\s"'[,-])(\.\/)?stack\.env\b/m.test(out)) {
    out = out.replace(/(^|[\s"'[,-])(\.\/)?stack\.env\b/gm, (_m, pre) => `${pre}.env`);
    notes.push('"stack.env" (Portainer\'s variables file) now refers to the stack\'s .env');
  }
  if (/^\s*build:/m.test(out) || /^\s*-\s*["']?\.\.?\//m.test(out)) {
    notes.push('The compose file uses relative paths (a build context or ./ folders): they now resolve inside Bosun\'s stack folder, where those files do not exist');
  }
  return out;
}

/**
 * Several one-container compose files (one per container, as the package's export writes them) as one stack: each service
 * named as Compose knew it (so the running containers are recognised), the top-level volumes and networks merged.
 */
export function mergeComposeExports(parts: { service: string; text: string }[], notes: string[]): string {
  const services: string[] = [];
  const top = { volumes: new Map<string, string[]>(), networks: new Map<string, string[]>() };
  for (const { service, text } of parts) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let section = '';
    let current: string[] | null = null;
    let renamed = false;
    for (const line of lines) {
      if (line.startsWith('#')) {
        const m = /^# Not exported:\s*(.*)$/.exec(line);
        if (m && m[1]) notes.push(`${service}: not carried over: ${m[1]}`);
        continue;
      }
      if (/^\S/.test(line)) { section = line.replace(/:.*$/, ''); current = null; continue; }
      if (!line.trim()) continue;
      if (section === 'services') {
        if (!renamed && /^ {2}\S/.test(line)) { services.push(`  ${service}:`); renamed = true; continue; }
        services.push(line);
      } else if (section === 'volumes' || section === 'networks') {
        if (/^ {2}\S/.test(line)) {
          const key = line.trim().replace(/:.*$/, '');
          const map = top[section];
          current = map.has(key) ? null : [line];
          if (current) map.set(key, current);
        } else if (current) current.push(line);
      }
    }
  }
  const block = (name: string, m: Map<string, string[]>) => (m.size ? [`${name}:`, ...Array.from(m.values()).flat()] : []);
  return [...['services:', ...services], ...block('volumes', top.volumes), ...block('networks', top.networks)].join('\n') + '\n';
}

/** Is `name` a stack name Bosun's deployment accepts? */
export const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
