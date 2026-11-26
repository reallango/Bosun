import { describe, expect, it } from 'vitest';
import { buildWidgetMenu } from './widget-menu';

const packageItems = [
  { id: 'new-container', label: 'New container' },
  { id: 'manage', label: 'Manage' },
];

describe('buildWidgetMenu', () => {
  it('puts the package entries under the widget name and the frame entries under "Widget"', () => {
    const menu = buildWidgetMenu('Docker Containers', packageItems, { canEdit: true });

    expect(menu.widget?.label).toBe('Docker Containers');
    expect(menu.widget?.items.map(item => item.label)).toEqual(['New container', 'Manage']);
    expect(menu.frame.label).toBe('Widget');
    expect(menu.frame.items.map(item => item.label)).toEqual(['Refresh', 'Settings', 'Remove']);
  });

  it('keeps Remove last and destructive', () => {
    const { frame } = buildWidgetMenu('Disk', [], { canEdit: true });

    expect(frame.items.at(-1)).toEqual({ id: 'remove', label: 'Remove', destructive: true });
    expect(frame.items.filter(item => item.destructive)).toHaveLength(1);
  });

  it('leaves out Settings and Remove when the person may not edit the dashboard', () => {
    const { frame } = buildWidgetMenu('Disk', [], { canEdit: false });

    expect(frame.items.map(item => item.id)).toEqual(['refresh']);
  });

  it('has no widget group when the package adds no entries', () => {
    expect(buildWidgetMenu('Disk', [], { canEdit: true }).widget).toBeNull();
  });

  it('does not change the package items it is given', () => {
    const items = [{ id: 'a', label: 'A' }];
    const menu = buildWidgetMenu('Widget', items, { canEdit: true });

    menu.widget?.items.push({ id: 'b', label: 'B' });
    expect(items).toEqual([{ id: 'a', label: 'A' }]);
  });
});
