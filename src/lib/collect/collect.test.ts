import { describe, it, expect } from 'vitest';
import * as linux from './linux';
import * as windows from './windows';
import * as store from './store';

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
Buffers:          100000 kB
Cached:          4000000 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB`;

const NETDEV = (rx: number, tx: number) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0
  eth0: ${rx} 100 0 0 0 0 0 0 ${tx} 100 0 0 0 0 0 0
veth12: 5000000 1 0 0 0 0 0 0 5000000 1 0 0 0 0 0 0`;

function output(stat: string, rx: number, tx: number) {
  return [
    '', '@@BOSUN stat', stat, '8',
    '@@BOSUN mem', MEMINFO,
    '@@BOSUN load', '0.50 0.40 0.30 1/100 1234', '3600.5 7000.0',
    '@@BOSUN temp', 'acpitz 30000', 'x86_pkg_temp 55000',
    '@@BOSUN netdev', NETDEV(rx, tx),
    '@@BOSUN gpu', '0, NVIDIA GeForce RTX 3060, 12288, 1024, 37, 51, 25.30, 170.00, 30',
    '@@BOSUN df',
    '/dev/sda2 ext4 102400000 51200000 51200000 50% /',
    'tmpfs tmpfs 1000 0 1000 0% /run',
    '/dev/sdb1 xfs 204800000 184320000 20480000 90% /mnt/data media',
    '@@BOSUN docker', 'RC 0',
    '{"ID":"abcdef1234567890","Names":"web","Image":"nginx:1","Status":"Up 2 hours","State":"running","Ports":"80/tcp","Labels":"com.docker.compose.project=site"}',
    '{"ID":"0123456789abcdef","Names":"job","Image":"alpine","Status":"Exited (0) 1 hour ago","State":"exited","Ports":"","Labels":""}',
    '@@BOSUN ollama', '{"version":"0.5.1"}',
    '{"models":[{"name":"tiny:latest","size":100,"modified_at":"x","digest":"sha256:abc","details":{"family":"llama","parameter_size":"1B","quantization_level":"Q4"}}]}',
    '{"models":[{"name":"tiny:latest","size":100,"size_vram":100}]}',
    '@@BOSUN end', '',
  ].join('\n');
}

describe('linux collector', () => {
  it('builds a command that only passes known probe names', () => {
    const cmd = linux.buildCommand(['stat', 'mem; rm -rf /', 'docker']);
    expect(cmd).toContain('sh -s stat docker');
    expect(cmd).not.toContain('rm -rf');
    expect(cmd).toContain('nice -n 19');
  });

  it('parses sections and derives CPU% and network rates from deltas', () => {
    const t0 = 1_000_000;
    const a = linux.buildSnapshot(linux.splitSections(output('cpu 100 0 100 800 0 0 0 0', 1000, 2000)), null, t0);
    expect(a.sections.cpu_memory.cpu.usagePercent).toBeNull(); // first poll has no delta
    expect(a.metrics['cpu.usage']).toBeUndefined();

    const b = linux.buildSnapshot(linux.splitSections(output('cpu 150 0 150 900 0 0 0 0', 11000, 4000)), a.state, t0 + 10_000);
    const cm = b.sections.cpu_memory;
    expect(cm.cpu.usagePercent).toBe(50); // 100 busy of 200 total
    expect(cm.cpu.temperature).toBe(55); // prefers the package sensor
    expect(cm.cpu.threads).toBe(8);
    expect(cm.memory.totalMB).toBe(16000);
    expect(cm.memory.usedMB).toBe(8000);
    expect(cm.memory.swapUsedMB).toBe(1024);
    expect(b.metrics['net.rx_bps']).toBe(1000); // eth0 only; lo and veth excluded
    expect(b.metrics['net.tx_bps']).toBe(200);

    expect(b.sections.disks.map((d: { mountPoint: string }) => d.mountPoint)).toEqual(['/', '/mnt/data media']);
    expect(b.metrics['disk.root_used_pct']).toBe(50);
    expect(b.metrics['disk.max_used_pct']).toBe(90);

    expect(b.sections.gpus[0]).toMatchObject({ index: 0, name: 'NVIDIA GeForce RTX 3060', vram_total_mb: 12288, utilization_percent: 37, power_limit_watts: 170 });
    expect(b.metrics['gpu0.util']).toBe(37);

    expect(b.sections.docker.available).toBe(true);
    expect(b.sections.docker.containers[0]).toMatchObject({ id: 'abcdef123456', name: 'web', state: 'running', compose: 'site' });
    expect(b.metrics['docker.running']).toBe(1);

    expect(b.sections.ollama).toMatchObject({ status: 'running', version: '0.5.1' });
    expect(b.sections.ollama.models[0]).toMatchObject({ name: 'tiny:latest', loaded: true, parameter_size: '1B' });
  });

  it('reports docker permission problems clearly', () => {
    const d = linux._parsers.parseDocker('RC 1\npermission denied while trying to connect to the Docker daemon socket');
    expect(d.available).toBe(false);
    expect(d.error).toMatch(/docker group/);
  });

  it('treats a counter reset as no sample instead of a negative rate', () => {
    const a = linux.buildSnapshot({ netdev: NETDEV(5000, 5000) }, null, 0);
    const b = linux.buildSnapshot({ netdev: NETDEV(10, 10) }, a.state, 10_000);
    expect(b.metrics['net.rx_bps']).toBe(0);
  });
});

describe('windows collector', () => {
  it('encodes the script and validates probe names', () => {
    const cmd = windows.buildCommand(['stat', "x'; Remove-Item C:\\"]);
    expect(cmd).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
    const script = Buffer.from(cmd.split(' ').pop() as string, 'base64').toString('utf16le');
    expect(script.startsWith("$Probes = @('stat')")).toBe(true);
  });

  it('normalises Windows probes to the Linux shapes', () => {
    const raw = (busy: number, ts: number) => ({
      stat: JSON.stringify({ busy100ns: busy, ts100ns: ts, threads: 16, uptimeSeconds: 100 }),
      mem: JSON.stringify({ totalKB: 32 * 1024 * 1024, freeKB: 8 * 1024 * 1024, pageTotalKB: 1024 * 1024, pageFreeKB: 512 * 1024 }),
      df: JSON.stringify([{ id: 'C:', fs: 'NTFS', size: 100 * 1048576, free: 25 * 1048576, label: 'OS' }, { id: 'D:', size: 0, free: 0 }]),
    });
    const a = windows.buildSnapshot(raw(1_000_000, 10_000_000), null, 0);
    // 1e7 ticks elapsed, 2.5e6 idle -> 75% busy
    const b = windows.buildSnapshot(raw(3_500_000, 20_000_000), a.state, 1000);
    expect(b.sections.cpu_memory.cpu.usagePercent).toBe(75);
    expect(b.sections.cpu_memory.memory).toMatchObject({ totalMB: 32768, usedMB: 24576, usagePercent: 75 });
    expect(b.sections.disks).toEqual([{ filesystem: 'OS', fsType: 'NTFS', sizeMB: 100, usedMB: 75, availableMB: 25, usagePercent: 75, mountPoint: 'C:' }]);
    expect(b.metrics['disk.root_used_pct']).toBe(75);
  });
});

describe('store', () => {
  it('writes snapshots, samples and both rollups in one batch, and skips unchanged snapshots', () => {
    const hashes = new Map<string, string>();
    const snap = { sections: { disks: [{ mountPoint: '/' }] }, metrics: { 'cpu.usage': 12.5, bad: Number.NaN } };
    const first = store.buildPollStatements('srv', snap, 1_700_000_123_000, hashes);
    expect(first.filter(s => s.sql.startsWith('INSERT INTO host_snapshots'))).toHaveLength(1);
    expect(first.filter(s => s.sql.startsWith('INSERT OR REPLACE INTO metric_samples'))).toHaveLength(1);
    const rollups = first.filter(s => s.sql.startsWith('INSERT INTO metric_rollups'));
    expect(rollups.map(s => s.params[2])).toEqual([300, 3600]);
    expect(rollups[0].params[3]).toBe(1_700_000_100); // 5-minute bucket start
    expect(rollups[1].params[3]).toBe(1_699_999_200); // hour bucket start

    const second = store.buildPollStatements('srv', snap, 1_700_000_138_000, hashes);
    expect(second.some(s => s.sql.startsWith('INSERT INTO host_snapshots'))).toBe(false);
    expect(second.some(s => s.sql.startsWith('UPDATE host_snapshots SET collected_at'))).toBe(true);
  });

  it('builds retention deletes from config', () => {
    const st = store.retentionStatements({ rawHours: 1, rollup5mDays: 1, rollup1hDays: 2 }, 1_000_000_000);
    expect(st.map(s => s.params[0])).toEqual([1_000_000 - 3600, 1_000_000 - 86400, 1_000_000 - 172800]);
  });
});

describe('linux update parsing', () => {
  it('reads apt versions, security origin and pending reboot', () => {
    const r = linux._parsers.parseUpdates([
      'MGR apt',
      'Inst openssl [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])',
      'Inst curl [8.5.0-2ubuntu10.4] (8.5.0-2ubuntu10.5 Ubuntu:24.04/noble-updates [amd64])',
      'REBOOT 1',
    ].join('\n'));
    expect(r).toMatchObject({ manager: 'apt', updatesAvailable: 2, securityUpdates: 1, rebootRequired: true });
    expect(r.packages[0]).toEqual({ name: 'openssl', current_version: '3.0.13-0ubuntu3.4', new_version: '3.0.13-0ubuntu3.5', is_security: true });
    expect(r).not.toHaveProperty('lastCheck');
  });
  it('reads dnf check-update output', () => {
    const r = linux._parsers.parseUpdates('MGR dnf\nkernel.x86_64  6.8.1-1.fc40  updates\n');
    expect(r.packages).toEqual([{ name: 'kernel.x86_64', current_version: '', new_version: '6.8.1-1.fc40', is_security: false }]);
    expect(r.rebootRequired).toBe(false);
  });
});
