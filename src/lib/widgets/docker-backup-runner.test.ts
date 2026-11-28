import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { buildScriptInvocation, parseScriptOutput } from './runtime/script-run';

// The backup scripts against a fake `docker` that records its exact argv and answers with canned restic output. A real
// POSIX shell is needed (Alpine's busybox sh in the Docker build). The restic engine runs as a container, so the order of
// `docker run` matters: every docker option, then the image, then restic's own options and the subcommand. A script test
// that only compares text once let a missing image (and restic options in the docker option list) through.
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'exit 0']).status === 0;
const dir = path.join(process.cwd(), 'widgets', 'docker', 'scripts');
const script = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

const IMAGE = 'restic/restic:0.17.3';
const CID = 'a'.repeat(64);
const SNAP = 'c'.repeat(64);
const IMGID = 'sha256:' + '2'.repeat(64);
const DIG = '1'.repeat(64);

let bin = '';
let log = '';
let home = '';
beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-backuprun-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-backuphome-'));
  log = path.join(bin, 'calls.log');
  fs.writeFileSync(log, '');
});
afterEach(() => {
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** A fake docker: it logs every call, then answers the handful of queries the scripts make. */
const fakeDocker = () => fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
{ echo "CALL"; for a in "$@"; do printf 'ARG %s\\n' "$a"; done; } >> "$LOG"
case "$1" in
  ps) exit 0 ;;
  image) case "$2" in
    inspect) case "$*" in
      *RepoDigests*) echo '["nginx@sha256:${DIG}"]' ;;
      *opencontainers*) echo 1.2.3 ;;
      *) exit 0 ;;
    esac ;;
    *) exit 0 ;;
  esac ;;
  inspect) case "$*" in
    *'{{range .Mounts}}'*) printf 'volume\\tdata\\t/var/lib/docker/volumes/data/_data\\t/data\\ttrue\\n' ;;
    *'{{json .Config.Labels}}'*) echo '{}' ;;
    *'{{.Name}}'*) echo /web ;;
    *RUN*) printf 'ID %s\\nRUN true\\n' ${CID} ;;
    *REF*) printf 'ID %s\\nREF nginx:latest\\nIMGID ${IMGID}\\nPROJ \\nSVC \\n' ${CID} ;;
    *'{{.State.Running}}'*) echo true ;;
    *'{{.Id}}'*) echo ${CID} ;;
    *'{{.Image}}'*) echo ${IMGID} ;;
    *) exit 0 ;;
  esac ;;
  run) case "$*" in
    *'--entrypoint /bin/sh'*) case "$*" in *'du -sk'*) echo 0 ;; *) echo ok ;; esac ;;
    *' cat config'*) exit \${FAKE_CONFIG_RC:-0} ;;
    *' init '*) echo init ;;
    *' snapshots --json'*) echo '[]' ;;
    *' backup '*) echo '{"snapshot_id":"${SNAP}","data_added":1}' ;;
    *' forget '*) echo forget ;;
    *' restore '*) echo restore ;;
    *' stats '*) echo '{"total_size":0}' ;;
    *dump*restore_map*) printf 'web\\tvolume\\tdata\\t/data\\ttrue\\t/bosun/data/0-v1\\n' ;;
    *) exit 0 ;;
  esac ;;
  volume) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

/** Every docker call as its argv (without the command name). */
const dockerCalls = (): string[][] => {
  const out: string[][] = [];
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (line === 'CALL') out.push([]);
    else if (line.startsWith('ARG ') && out.length) out[out.length - 1].push(line.slice(4));
  }
  return out;
};
const runCalls = () => dockerCalls().filter(c => c[0] === 'run').map(c => c.slice(1));

const run = (file: string, params: Record<string, string>, env: Record<string, string> = {}) => {
  const inv = buildScriptInvocation('linux', script(file), params, { stdinParams: ['settings'] });
  const full: Record<string, string> = { ...process.env as Record<string, string>, PATH: `${bin}${path.delimiter}${process.env.PATH}`, LOG: log, HOME: home, ...env };
  return spawnSync('sh', ['-c', inv.command], { input: inv.stdin, encoding: 'utf8', cwd: bin, env: full as NodeJS.ProcessEnv });
};

const DOCKER_VALUE_FLAGS = new Set(['--name', '--label', '-e', '-v', '--entrypoint']);
/** The index the image must have: right after `docker run`'s own options (and their values). */
const imageAt = (argv: string[]): number => {
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--rm') { i += 1; continue; }
    if (DOCKER_VALUE_FLAGS.has(argv[i])) { i += 2; continue; }
    break;
  }
  return i;
};

/**
 * The core rule: the image comes immediately after the docker options, and nothing that belongs to docker follows it;
 * `-r` (the repository), any `-o` option and the restic subcommand all come after the image.
 */
const expectResticRun = (argv: string[], subcommand: string) => {
  const i = imageAt(argv);
  expect(argv[i], `image must follow the docker options: ${argv.join(' ')}`).toBe(IMAGE);
  const rest = argv.slice(i + 1);
  for (const flag of ['--rm', '--name', '--label', '-e', '-v', '--entrypoint']) {
    expect(rest, `docker option ${flag} must not come after the image: ${argv.join(' ')}`).not.toContain(flag);
  }
  expect(argv.indexOf('-r'), `-r must come after the image: ${argv.join(' ')}`).toBeGreaterThan(i);
  expect(argv.indexOf(subcommand), `${subcommand} must come after the image: ${argv.join(' ')}`).toBeGreaterThan(i);
  return i;
};

/** A shell helper (du/cp) runs no restic: the image follows docker's own options and restic options are left out. */
const expectShellRun = (argv: string[]) => {
  const i = imageAt(argv);
  expect(argv[i]).toBe(IMAGE);
  expect(argv.slice(i + 1)[0]).toBe('-c');
  expect(argv.slice(0, i)).toEqual(expect.arrayContaining(['--entrypoint', '/bin/sh']));
  expect(argv.indexOf('-r')).toBe(-1);
  expect(argv.some(a => a === '-o' || a.startsWith('sftp.args='))).toBe(false);
  return argv.slice(i + 1);
};

const local = (extra: Record<string, string> = {}) => ({
  BOSUN_CRED_BACKUP_DESTINATION_REPOSITORY: path.join(bin, 'repo'),
  BOSUN_CRED_BACKUP_DESTINATION_PASSWORD: 'repo-pw',
  ...extra,
});
const sftp = (extra: Record<string, string> = {}) => ({
  BOSUN_CRED_BACKUP_DESTINATION_REPOSITORY: 'sftp:user@host:/srv/repo',
  BOSUN_CRED_BACKUP_DESTINATION_PASSWORD: 'repo-pw',
  BOSUN_CRED_BACKUP_DESTINATION_CREDENTIALS: Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nKEY\n-----END OPENSSH PRIVATE KEY-----').toString('base64'),
  ...extra,
});
const s3 = (extra: Record<string, string> = {}) => ({
  BOSUN_CRED_BACKUP_DESTINATION_REPOSITORY: 's3:https://endpoint.example/bucket/prefix',
  BOSUN_CRED_BACKUP_DESTINATION_PASSWORD: 'repo-pw',
  BOSUN_CRED_BACKUP_DESTINATION_CREDENTIALS: 'ACCESS_KEY:SECRET_KEY',
  ...extra,
});

describe.skipIf(!hasSh)('the restic engine runs with the image after the docker options', () => {
  const settings = 'volumes=true\nbinds=false\nimage=false';

  it('initialises a local repository', () => {
    fakeDocker();
    const r = run('backup_run.sh', { mode: 'init', kind: 'container', name: '-' }, { ...local(), FAKE_CONFIG_RC: '1' });
    expect(parseScriptOutput(r.stdout).error).toBeNull();
    const init = runCalls().find(c => c.includes('init'))!;
    expectResticRun(init, 'init');
    expect(init).toEqual(expect.arrayContaining(['-r', '/bosun/repo']));
  });

  it('initialises an SFTP repository with its -o option after the image', () => {
    fakeDocker();
    const r = run('backup_run.sh', { mode: 'init', kind: 'container', name: '-' }, { ...sftp(), FAKE_CONFIG_RC: '1' });
    expect(parseScriptOutput(r.stdout).error).toBeNull();
    const init = runCalls().find(c => c.includes('init'))!;
    const i = expectResticRun(init, 'init');
    const extra = init.slice(i + 1);
    expect(extra).toContain('-o');
    expect(extra.findIndex(a => a === '-o')).toBeLessThan(extra.findIndex(a => a === '-r'));
    expect(extra.some(a => a.startsWith('sftp.args=-i /bosun/secret/id'))).toBe(true);
  });

  it('initialises an S3 repository', () => {
    fakeDocker();
    const r = run('backup_run.sh', { mode: 'init', kind: 'container', name: '-' }, { ...s3(), FAKE_CONFIG_RC: '1' });
    expect(parseScriptOutput(r.stdout).error).toBeNull();
    const init = runCalls().find(c => c.includes('init'))!;
    expectResticRun(init, 'init');
    expect(init).toContain('s3:https://endpoint.example/bucket/prefix');
  });

  it('runs a backup, the parent lookup, the tag and the retention for every destination kind', () => {
    const cases: [string, Record<string, string>][] = [['local', local()], ['sftp', sftp()], ['s3', s3()]];
    for (const [name, env] of cases) {
      fs.writeFileSync(log, '');
      fakeDocker();
      const r = run('backup_run.sh', { mode: 'run', kind: 'container', name: 'web', settings }, env);
      expect(parseScriptOutput(r.stdout).error, name).toBeNull();
      const calls = runCalls();
      const snapshots = calls.find(c => c.includes('snapshots'))!;
      expectResticRun(snapshots, 'snapshots');
      const backup = calls.find(c => c.includes('backup'))!;
      expectResticRun(backup, 'backup');
      expect(backup).toContain('--host');
      const tag = calls.find(c => c.includes('tag'))!;
      expectResticRun(tag, 'tag');
      const forget = calls.find(c => c.includes('forget'))!;
      expectResticRun(forget, 'forget');
      for (const argv of calls) expect(argv[imageAt(argv)], name).toBe(IMAGE);
      if (name === 'sftp') {
        const i = backup.indexOf(IMAGE);
        expect(backup.slice(i + 1)).toContain('-o');
        expect(backup.slice(i + 1).some(a => a.startsWith('sftp.args='))).toBe(true);
      }
    }
  });

  it('lists the repository, restores a snapshot and forgets one', () => {
    fakeDocker();
    let r = run('backup_restore.sh', { mode: 'list', kind: 'all', name: '-', settings: 'mode=list' }, local());
    expect(parseScriptOutput(r.stdout).error).toBeNull();
    for (const [sub, call] of [['cat', 'cat config'], ['snapshots', 'snapshots'], ['stats', 'stats']] as const) {
      const argv = runCalls().find(c => c.join(' ').includes(call))!;
      expectResticRun(argv, sub === 'cat' ? 'cat' : sub);
    }

    fs.writeFileSync(log, '');
    r = run('backup_restore.sh', {
      mode: 'restore', kind: 'container', name: 'web', snapshot: CID,
      settings: 'pin_image=false\nrestore_mode=replace\nmode=restore',
    }, sftp());
    expect(parseScriptOutput(r.stdout).error).toBeNull();
    const restore = runCalls().find(c => c.includes('restore'))!;
    const i = expectResticRun(restore, 'restore');
    expect(restore.slice(i + 1)).toContain('-o');
    expect(restore.slice(i + 1)).toContain('--target');

    fs.writeFileSync(log, '');
    r = run('backup_restore.sh', { mode: 'forget', kind: 'container', name: 'web', snapshot: CID, settings: 'mode=forget' }, local());
    expect(parseScriptOutput(r.stdout).error).toBeNull();
    expectResticRun(runCalls().find(c => c.includes('forget'))!, 'forget');
  });

  it('names the destination the status refers to, falling back to the repository path', () => {
    fakeDocker();
    let r = run('backup_restore.sh', { mode: 'list', kind: 'all', name: '-', settings: 'mode=list' },
      local({ BOSUN_CRED_BACKUP_DESTINATION_NAME: 'Backup-Test' }));
    expect(parseScriptOutput(r.stdout).error).toBeNull();
    expect(JSON.parse(r.stdout).status).toMatchObject({ destination_name: 'Backup-Test', repository: path.join(bin, 'repo') });

    fs.writeFileSync(log, '');
    fakeDocker();
    r = run('backup_restore.sh', { mode: 'list', kind: 'all', name: '-', settings: 'mode=list' }, local());
    expect(JSON.parse(r.stdout).status.destination_name).toBe(path.join(bin, 'repo'));
  });

  it('keeps restic options away from the shell helper and out of the docker option list', () => {
    fakeDocker();
    const r = run('backup_run.sh', { mode: 'run', kind: 'container', name: 'web', settings: 'volumes=true\nbinds=false\nimage=false' }, sftp());
    expect(parseScriptOutput(r.stdout).error).toBeNull();
    const shells = runCalls().filter(c => c.includes('--entrypoint'));
    expect(shells.length).toBeGreaterThan(0);
    for (const argv of shells) expectShellRun(argv);
  });
});
