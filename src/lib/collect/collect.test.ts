import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'zlib';
import { randomBytes } from 'crypto';
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

const CORE = (busy: number, idle: number, i: number) => `cpu${i} ${busy} 0 ${busy} ${idle} 0 0 0 0`;
const CORES = (busy: number, idle: number) => Array.from({ length: 8 }, (_, i) => CORE(busy, idle, i)).join('\n');

const DISKSTATS = (readSectors: number, writeSectors: number) => [
  `   8 0 sda 10 0 ${readSectors} 0 20 0 ${writeSectors} 0 0 0 0 0 0`,
  `   8 1 sda1 10 0 ${readSectors} 0 20 0 ${writeSectors} 0 0 0 0 0 0`,
  '   8 16 sdb 10 0 100 0 20 0 200 0 0 0 0 0 0',
].join('\n');

const IP = JSON.stringify([
  { ifname: 'eth0', operstate: 'UP', mtu: 1500, address: 'aa:bb:cc:dd:ee:ff', addr_info: [{ family: 'inet', local: '192.168.1.130' }] },
  { ifname: 'eth1', operstate: 'DOWN', mtu: 1500, address: 'aa:bb:cc:dd:ee:00', addr_info: [] },
]);

function output(stat: string, rx: number, tx: number, opts: { busy?: number; idle?: number; read?: number; write?: number } = {}) {
  return [
    '', '@@BOSUN stat', stat, CORES(opts.busy ?? 25, opts.idle ?? 100),
    '@@BOSUN mem', MEMINFO,
    '@@BOSUN load', '0.50 0.40 0.30 1/100 1234', '3600.5 7000.0',
    '@@BOSUN temp', 'acpitz 30000', 'x86_pkg_temp 55000',
    '@@BOSUN netdev', NETDEV(rx, tx),
    '@@BOSUN diskstats', DISKSTATS(opts.read ?? 1000, opts.write ?? 2000),
    '@@BOSUN gpu', '0, NVIDIA GeForce RTX 3060, 12288, 1024, 37, 51, 25.30, 170.00, 30',
    '@@BOSUN df',
    '/dev/sda2 ext4 102400000 51200000 51200000 50% /',
    'tmpfs tmpfs 1000 0 1000 0% /run',
    '/dev/sdb1 xfs 204800000 184320000 20480000 90% /mnt/data media',
    '@@BOSUN ip',
    'SSHCONN 10.0.0.5 2222 192.168.1.130 22',
    'PHYS eth0 eth1',
    'WIFI',
    'DEFAULT eth0',
    IP,
    '@@BOSUN end', '',
  ].join('\n');
}

describe('linux collector', () => {
  it('builds a command that only passes known probe names', () => {
    const cmd = linux.buildCommand(['stat', 'mem; rm -rf /', 'df']);
    expect(cmd).toContain('sh -s stat df');
    expect(cmd).not.toContain('rm -rf');
    expect(cmd).toContain('nice -n 19');
  });

  it('parses sections and derives CPU% and network rates from deltas', () => {
    const t0 = 1_000_000;
    const a = linux.buildSnapshot(linux.splitSections(output('cpu 100 0 100 800 0 0 0 0', 1000, 2000)), null, t0);
    expect(a.sections.cpu_memory.cpu.usagePercent).toBeNull(); // first poll has no delta
    expect(a.sections.cpu_memory.cpu.cores).toHaveLength(8);
    expect(a.sections.cpu_memory.cpu.cores[0].usagePercent).toBeNull();
    expect(a.metrics['cpu.usage']).toBeUndefined();

    const b = linux.buildSnapshot(linux.splitSections(output('cpu 150 0 150 900 0 0 0 0', 11000, 4000, { busy: 50, idle: 150 })), a.state, t0 + 10_000);
    const cm = b.sections.cpu_memory;
    expect(cm.cpu.usagePercent).toBe(50); // 100 busy of 200 total
    expect(cm.cpu.temperature).toBe(55); // prefers the package sensor
    expect(cm.cpu.threads).toBe(8);
    expect(cm.cpu.cores).toHaveLength(8);
    expect(cm.cpu.cores[0]).toEqual({ id: 0, usagePercent: 50 });
    expect(cm.memory.totalMB).toBe(16000);
    expect(cm.memory.usedMB).toBe(8000);
    expect(cm.memory.swapUsedMB).toBe(1024);
    expect(b.metrics['net.rx_bps']).toBe(1000); // eth0 only; lo and veth excluded
    expect(b.metrics['net.tx_bps']).toBe(200);

    expect(b.sections.disks.map((d: { mountPoint: string }) => d.mountPoint)).toEqual(['/', '/mnt/data media']);
    expect(b.metrics['disk.root_used_pct']).toBe(50);
    expect(b.metrics['disk.max_used_pct']).toBe(90);

    expect(b.sections.network_headline).toEqual({ name: 'eth0', ipv4: '192.168.1.130', state: 'UP', macAddress: 'aa:bb:cc:dd:ee:ff' });

    expect(b.sections.gpus[0]).toMatchObject({ index: 0, name: 'NVIDIA GeForce RTX 3060', vram_total_mb: 12288, utilization_percent: 37, power_limit_watts: 170 });
    expect(b.metrics['gpu0.util']).toBe(37);
    expect(b.metrics['gpu0.vram_mb']).toBe(1024);
    expect(b.metrics['gpu0.vram_pct']).toBe(8);

    expect(b.sections.docker).toBeUndefined();   // what a widget needs about Docker is collected by the widget's own package
    expect(b.metrics['docker.running']).toBeUndefined();

    expect(b.sections.ollama).toBeUndefined();   // widget-specific data is collected by the widget's own package, not by the poller's probes
  });

  it('keeps the last disk usage in the metrics snapshot between disk probes, but not in the history', () => {
    const t0 = 1_000_000;
    // a full poll (disks included), then a fast poll without the df probe
    const a = linux.buildSnapshot(linux.splitSections(output('cpu 100 0 100 800 0 0 0 0', 1000, 2000)), null, t0);
    const { df: _skip, ...fast } = linux.splitSections(output('cpu 150 0 150 900 0 0 0 0', 11000, 4000));
    const b = linux.buildSnapshot(fast, a.state, t0 + 10_000);
    expect(b.sections.disks).toBeUndefined();                        // the disks section is only written when df ran
    expect(b.sections.metrics.disk).toEqual({ root_used_pct: 50, max_used_pct: 90, read_bps: 0, write_bps: 0 }); // the snapshot keeps them
    expect(b.metrics['disk.root_used_pct']).toBeUndefined();        // the history only records real samples
    expect(b.sections.metrics.cpu.usage).toBe(50);                  // this poll's own numbers are there too
    // the next disk probe replaces them (a disk that is gone does not linger)
    const c = linux.buildSnapshot(linux.splitSections(output('cpu 200 0 200 1000 0 0 0 0', 12000, 5000)), b.state, t0 + 20_000);
    expect(c.sections.metrics.disk.root_used_pct).toBe(50);
  });

  it('derives per-disk throughput from diskstats and maps it onto mounts', () => {
    const t0 = 1_000_000;
    const a = linux.buildSnapshot(linux.splitSections(output('cpu 100 0 100 800 0 0 0 0', 1000, 2000, { read: 1000, write: 2000 })), null, t0);
    const b = linux.buildSnapshot(linux.splitSections(output('cpu 100 0 100 800 0 0 0 0', 1000, 2000, { read: 2024, write: 3024 })), a.state, t0 + 2000);
    // 1024 sectors of 512 bytes over 2 s; partitions and the unchanged disk add nothing.
    expect(b.sections.disk_io.readBps).toBe(262144);
    expect(b.sections.disk_io.writeBps).toBe(262144);
    expect(b.metrics['disk.read_bps']).toBe(262144);
    expect(b.metrics['disk.write_bps']).toBe(262144);
    expect(b.sections.disks.find((d: { mountPoint: string }) => d.mountPoint === '/')).toMatchObject({ readBps: 262144, writeBps: 262144 });
    expect(linux._parsers.deviceForMount('/dev/sda2', new Set(['sda']))).toBe('sda');
    expect(linux._parsers.deviceForMount('/dev/mapper/vg-root', new Set(['sda']))).toBeNull();
  });

  it('treats a counter reset as no sample instead of a negative rate', () => {
    const a = linux.buildSnapshot({ netdev: NETDEV(5000, 5000) }, null, 0);
    const b = linux.buildSnapshot({ netdev: NETDEV(10, 10) }, a.state, 10_000);
    expect(b.metrics['net.rx_bps']).toBe(0);
  });
});

/** The script a powershell.exe command line will run, whichever encoding was used. */
function scriptOf(cmd: string): string {
  const encoded = cmd.match(/ -EncodedCommand ([A-Za-z0-9+/=]+)$/);
  if (encoded) return Buffer.from(encoded[1], 'base64').toString('utf16le');
  const gz = cmd.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  return gunzipSync(Buffer.from((gz as RegExpMatchArray)[1], 'base64')).toString('utf8');
}

// Windows OpenSSH runs exec requests through cmd.exe, which refuses command lines over 8191 characters.
const CMD_EXE_LIMIT = 8191;

describe('windows collector', () => {
  it('encodes the script and validates probe names', () => {
    const cmd = windows.buildCommand(['stat', "x'; Remove-Item C:\\"]);
    expect(cmd).toMatch(/^powershell\.exe /);
    const script = scriptOf(cmd);
    expect(script.startsWith("$Probes = @('stat')")).toBe(true);
    expect(script).toContain(windows.SCRIPT);
  });

  it('keeps every poll command under the cmd.exe command-line limit', () => {
    for (const probes of [windows.PROBES, ['stat', 'mem', 'netdev'], ['stat']]) {
      const cmd = windows.buildCommand(probes);
      expect(cmd.length).toBeLessThan(CMD_EXE_LIMIT);
      // the bootstrap must not contain anything cmd.exe would interpret
      const withoutQuotedPayload = cmd.replace(/'[A-Za-z0-9+/=]+'/, "''");
      expect(withoutQuotedPayload).not.toMatch(/[&|<>^%!]/);
    }
  });

  it('keeps short scripts on plain -EncodedCommand and long ones under the limit', () => {
    const short = windows.powershellCommand('Write-Output connected');
    expect(short).toMatch(/ -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(scriptOf(short)).toBe('Write-Output connected');

    const longScript = `Write-Output '${'x'.repeat(4000)}'`;   // the exec route allows 4000 characters of command
    const long = windows.powershellCommand(longScript);
    expect(long.length).toBeLessThan(CMD_EXE_LIMIT);
    expect(scriptOf(long)).toBe(longScript);

    const unicode = `Write-Output 'caf\u00e9 \u2713 ${'y'.repeat(4000)}'`;
    expect(scriptOf(windows.powershellCommand(unicode))).toBe(unicode);
  });

  it('refuses a script that cannot fit rather than sending a command that will fail', () => {
    const incompressible = randomBytes(9000).toString('base64');   // random data does not compress
    expect(() => windows.powershellCommand(`Write-Output '${incompressible}'`)).toThrow(/too large/);
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

  it('reports per-core usage, disk throughput and the default-route headline', () => {
    const raw = (cores: Array<[string, number, number]>, read: number, write: number) => ({
      stat: JSON.stringify({ busy100ns: 1_000_000, ts100ns: 10_000_000, threads: 2, uptimeSeconds: 100,
        cores: cores.map(([id, busy, ts]) => ({ id, busy100ns: busy, ts100ns: ts })) }),
      diskstats: JSON.stringify([{ name: '0 C:', read, write }, { name: '_Total', read, write }]),
      df: JSON.stringify([{ id: 'C:', fs: 'NTFS', size: 100 * 1048576, free: 25 * 1048576, label: 'OS' }]),
    });
    const a = windows.buildSnapshot(raw([['0', 1_000_000, 10_000_000], ['1', 1_000_000, 10_000_000]], 1_000_000, 0), null, 0);
    const b = windows.buildSnapshot(raw([['0', 2_000_000, 20_000_000], ['1', 5_000_000, 20_000_000]], 3_000_000, 4_000_000), a.state, 1000);
    expect(b.sections.cpu_memory.cpu.cores).toEqual([{ id: 0, usagePercent: 90 }, { id: 1, usagePercent: 60 }]);
    expect(b.sections.disk_io.readBps).toBe(2_000_000);
    expect(b.sections.disk_io.writeBps).toBe(4_000_000);
    expect(b.metrics['disk.read_bps']).toBe(2_000_000);
    expect(b.sections.disks[0]).toMatchObject({ mountPoint: 'C:', readBps: 2_000_000, writeBps: 4_000_000 });

    const ip = [
      'SSHCONN 10.0.0.5 2222 192.168.1.50 22',
      'DEFAULT 7',
      JSON.stringify([{ name: 'Ethernet', desc: 'Intel Ethernet', mac: 'AA-BB-CC-DD-EE-FF', idx: 7, up: true, ips: ['192.168.1.50'] }]),
    ].join('\n');
    const c = windows.buildSnapshot({ ip }, null, 0);
    expect(c.sections.network_headline).toEqual({ name: 'Ethernet', ipv4: '192.168.1.50', state: 'UP', macAddress: 'aa-bb-cc-dd-ee-ff' });
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
