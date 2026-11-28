import { describe, it, expect } from 'vitest';
import {
  ageSeconds,
  formatAge,
  instanceChoices,
  listInstances,
  noticeToastVariant,
  serverLabel,
  type InstanceRow,
  type WidgetInstance,
} from './screen-page';

const instance = (over: Partial<WidgetInstance> & { id: string }): WidgetInstance => ({
  widget_type: 'example_type',
  server_id: 'srv-1',
  server_name: 'nas',
  dashboard_id: 'dash-1',
  dashboard_name: 'Home',
  ...over,
});

describe('formatAge', () => {
  it('reads as a short age in seconds, minutes, hours and days', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(1.9)).toBe('just now');
    expect(formatAge(2)).toBe('2 s ago');
    expect(formatAge(59)).toBe('59 s ago');
    expect(formatAge(60)).toBe('1 min ago');
    expect(formatAge(3599)).toBe('59 min ago');
    expect(formatAge(3600)).toBe('1 h ago');
    expect(formatAge(86399)).toBe('23 h ago');
    expect(formatAge(86400)).toBe('1 d ago');
    expect(formatAge(3 * 86400)).toBe('3 d ago');
  });

  it('never counts backwards when the client clock is behind', () => {
    expect(formatAge(-5)).toBe('just now');
    expect(ageSeconds(2000, 1000)).toBe(0);
    expect(ageSeconds(0, 5400)).toBe(5);
  });
});

describe('serverLabel', () => {
  it('uses the server name, or a short id when it has none', () => {
    expect(serverLabel(instance({ id: 'w1' }))).toBe('nas');
    expect(serverLabel(instance({ id: 'w1', server_name: null, server_id: 'abcdef12-3456-7890' }))).toBe('Server abcdef12');
    expect(serverLabel(instance({ id: 'w1', server_name: null, server_id: '' }))).toBe('Server');
  });
});

describe('listInstances', () => {
  const rows: InstanceRow[] = [
    { id: 'w2', widget_type: 'example_type', server_id: 'srv-2', server_name: 'pve', dashboard_id: 'dash-2', dashboard_name: 'Lab' },
    { id: 'w1', widget_type: 'example_type', server_id: 'srv-1', server_name: 'nas', dashboard_id: 'dash-1', dashboard_name: 'Home' },
    { id: 'w3', widget_type: 'example_type', server_id: 'srv-3', server_name: 'hidden', dashboard_id: 'dash-hidden', dashboard_name: 'Secret' },
    { id: 'w1', widget_type: 'example_type', server_id: 'srv-1', server_name: 'nas', dashboard_id: 'dash-1', dashboard_name: 'Home' },
    { id: 'w4', widget_type: 'example_type', server_id: 'srv-4', server_name: 'orphan', dashboard_id: null, dashboard_name: null },
  ];

  it('keeps only instances on dashboards the caller can see, once each', () => {
    const out = listInstances(rows, new Set(['dash-1', 'dash-2']));
    expect(out.map(i => i.id)).toEqual(['w1', 'w2']);
    expect(out[0]).toEqual({
      id: 'w1', widget_type: 'example_type', server_id: 'srv-1', server_name: 'nas', dashboard_id: 'dash-1', dashboard_name: 'Home',
    });
  });

  it('sorts by server, then dashboard, then id', () => {
    const out = listInstances([
      { id: 'b', widget_type: 't', server_id: 's', server_name: 'same', dashboard_id: 'd2', dashboard_name: 'Zed' },
      { id: 'a', widget_type: 't', server_id: 's', server_name: 'same', dashboard_id: 'd1', dashboard_name: 'Alpha' },
      { id: 'c', widget_type: 't', server_id: 's', server_name: 'another', dashboard_id: 'd3', dashboard_name: 'Mid' },
    ], new Set(['d1', 'd2', 'd3']));
    expect(out.map(i => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('drops rows whose dashboard the caller may not see', () => {
    expect(listInstances(rows, new Set())).toEqual([]);
  });
});

describe('instanceChoices', () => {
  it('labels a single placement with the server name', () => {
    expect(instanceChoices([instance({ id: 'w1' })])).toEqual([{ id: 'w1', label: 'nas', server_id: 'srv-1' }]);
  });

  it('shows one entry per server, even when the widget is placed twice on it', () => {
    const choices = instanceChoices([
      instance({ id: 'w1', dashboard_id: 'd1', dashboard_name: 'Home' }),
      instance({ id: 'w2', dashboard_id: 'd2', dashboard_name: 'Lab' }),
      instance({ id: 'w3', server_id: 'srv-2', server_name: 'pve' }),
    ]);
    expect(choices).toEqual([
      { id: 'w1', label: 'nas', server_id: 'srv-1' },
      { id: 'w3', label: 'pve', server_id: 'srv-2' },
    ]);
  });

  it('uses the current instance for its server and the first otherwise', () => {
    const instances = [
      instance({ id: 'w1', dashboard_id: 'd1', dashboard_name: 'Home' }),
      instance({ id: 'w2', dashboard_id: 'd2', dashboard_name: 'Lab' }),
      instance({ id: 'w3', server_id: 'srv-2', server_name: 'pve' }),
    ];
    expect(instanceChoices(instances, 'w2').map(c => c.id)).toEqual(['w2', 'w3']);
    expect(instanceChoices(instances, 'w3').map(c => c.id)).toEqual(['w1', 'w3']);
  });

  it('keeps labels apart even when two servers share a name', () => {
    const choices = instanceChoices([
      instance({ id: 'w1', server_id: 'aaaaaaaa-1', server_name: 'nas' }),
      instance({ id: 'w2', server_id: 'bbbbbbbb-2', server_name: 'nas' }),
    ]);
    expect(choices.map(c => c.label)).toEqual(['nas (aaaaaaaa)', 'nas (bbbbbbbb)']);
    expect(new Set(choices.map(c => c.label)).size).toBe(2);
  });
});

describe('noticeToastVariant', () => {
  it('styles failures as errors and results as plain toasts', () => {
    expect(noticeToastVariant('Restart failed: exit 1')).toBe('error');
    expect(noticeToastVariant('Remove: this row has nothing to open it in')).toBe('error');
    expect(noticeToastVariant('Restart: no terminal token was returned')).toBe('error');
    expect(noticeToastVariant('The saved values of that task are not available')).toBe('error');
    expect(noticeToastVariant('Pull started. Follow it with the bell at the top (Tasks)')).toBe('default');
    expect(noticeToastVariant('Prune: done')).toBe('default');
  });
});
