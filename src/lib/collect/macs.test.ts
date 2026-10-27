import { describe, it, expect } from 'vitest';
import * as macs from './macs';
import * as linux from './linux';
import * as store from './store';

const eth = { name: 'eno1', mac: 'AA:BB:CC:00:00:01', physical: true, wireless: false, up: true, ipv4: ['192.168.1.20'] };
const wifi = { name: 'wlp2s0', mac: 'aa-bb-cc-00-00-02', physical: true, wireless: true, up: false, ipv4: [] };
const veth = { name: 'docker0', mac: '02:42:ac:11:00:01', physical: false, wireless: false, up: true, ipv4: ['172.17.0.1'] };

describe('pickMacs', () => {
  it('uses the NIC the SSH connection arrived on and offers the wired/wireless counterpart', () => {
    const r = macs.pickMacs([veth, wifi, eth], '192.168.1.20');
    expect(r.primary).toEqual({ name: 'eno1', mac: 'aa:bb:cc:00:00:01', wireless: false });
    expect(r.alt).toEqual({ name: 'wlp2s0', mac: 'aa:bb:cc:00:00:02', wireless: true });
  });
  it('picks wired over wireless when the connection address is unknown, and wireless->wired as alt', () => {
    expect(macs.pickMacs([wifi, eth], null).primary?.name).toBe('eno1');
    const onWifi = { ...wifi, up: true, ipv4: ['192.168.1.21'] };
    const r = macs.pickMacs([eth, onWifi], '192.168.1.21');
    expect([r.primary?.name, r.alt?.name]).toEqual(['wlp2s0', 'eno1']);
  });
  it('ignores virtual and zero MACs', () => {
    expect(macs.pickMacs([veth, { ...eth, mac: '00:00:00:00:00:00' }], null)).toMatchObject({ primary: null, alt: null });
  });
  it('parses SSH_CONNECTION', () => {
    expect(macs.serverIpFromSshConnection('192.168.1.161 51234 192.168.1.20 22')).toBe('192.168.1.20');
    expect(macs.serverIpFromSshConnection('')).toBeNull();
  });
});

describe('linux ip probe', () => {
  it('flags physical/wireless NICs and reports the SSH server address', () => {
    const json = JSON.stringify([
      { ifname: 'lo', address: '00:00:00:00:00:00', addr_info: [] },
      { ifname: 'eno1', operstate: 'UP', address: 'aa:bb:cc:00:00:01', addr_info: [{ family: 'inet', local: '192.168.1.20' }] },
      { ifname: 'wlp2s0', operstate: 'DOWN', address: 'aa:bb:cc:00:00:02', addr_info: [] },
      { ifname: 'docker0', operstate: 'UP', address: '02:42:ac:11:00:01', addr_info: [{ family: 'inet', local: '172.17.0.1' }] },
    ]);
    const text = ['SSHCONN 192.168.1.161 50000 192.168.1.20 22', 'PHYS eno1 wlp2s0', 'WIFI wlp2s0', json].join('\n');
    const p = linux._parsers.parseIpProbe(text);
    expect(p.serverIp).toBe('192.168.1.20');
    expect(p.interfaces.map((i: { name: string; physical: boolean; wireless: boolean }) => [i.name, i.physical, i.wireless])).toEqual([['eno1', true, false], ['wlp2s0', true, true], ['docker0', false, false]]);
    const snap = linux.buildSnapshot({ ip: text }, null);
    expect(snap.sections.nics.primary.mac).toBe('aa:bb:cc:00:00:01');
    expect(snap.sections.nics.alt.mac).toBe('aa:bb:cc:00:00:02');
  });
});

describe('MAC autofill statements', () => {
  it('only fills unset columns and keeps the alternate distinct', () => {
    const st = store.macAutofillStatements('s1', macs.pickMacs([eth, wifi], null));
    expect(st).toHaveLength(2);
    expect(st[0].sql).toMatch(/mac_address = \? WHERE id = \? AND mac_address IS NULL$/);
    expect(st[1].sql).toMatch(/mac_address_alt IS NULL AND COALESCE\(mac_address, ''\) <> \?/);
    expect(store.macAutofillStatements('s1', undefined)).toEqual([]);
  });
});
