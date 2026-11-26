'use client';

import { instanceChoices, serverLabel, type WidgetInstance } from './screen-page';

interface Props {
  /** Every placement of this widget type the person may open. */
  instances: WidgetInstance[];
  /** The placement this page shows. */
  currentId: string;
  /** Open the same screen for another placement (a different server, usually). */
  onOpen: (instanceId: string) => void;
}

/**
 * Next to the screen title: a small select with the servers where this widget type is placed. With a single
 * placement the server is plain text, and there is nothing to switch to.
 */
export function WidgetInstanceSwitcher({ instances, currentId, onOpen }: Props) {
  if (instances.length === 0) return null;

  const choices = instanceChoices(instances);
  if (choices.length === 1) {
    const only = instances.find(i => i.id === currentId) ?? instances[0];
    return <span className="min-w-0 truncate text-sm text-muted-foreground">{serverLabel(only)}</span>;
  }

  const value = choices.some(c => c.id === currentId) ? currentId : choices[0].id;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <label htmlFor="widget-screen-instance" className="sr-only">Server</label>
      <select
        id="widget-screen-instance"
        value={value}
        onChange={e => onOpen(e.target.value)}
        className="form-select h-7 w-auto min-w-0 max-w-[14rem] py-0 text-xs"
      >
        {choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
    </span>
  );
}
