/** Shared classes for the declarative widget renderer. Everything here uses theme
 * tokens so widgets follow the app shell in both light and dark mode. */

/** Small text input and select used by forms, editors and the list filter. */
export const inputClass =
  'w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/40 disabled:opacity-40';

/** Quiet bordered button: actions, cancel, dismiss, add row, copy, reload. */
export const buttonClass =
  'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-40';

/** Icon-only button: remove a row, close a dialog. */
export const iconButtonClass =
  'rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';

const submitButtonClass = 'inline-flex items-center gap-1 rounded-md px-3 py-1.5 font-medium disabled:opacity-40';

/** Solid submit button of an editor. */
export const primarySubmitClass = `${submitButtonClass} bg-primary text-primary-foreground hover:bg-primary/90`;
export const dangerSubmitClass = `${submitButtonClass} bg-destructive text-destructive-foreground hover:bg-destructive/90`;

/** Notice boxes, by level. Green and amber keep their fixed status colours. */
export const NOTICE_CLASS = {
  info: 'border-primary/30 bg-primary/10 text-primary',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
} as const;
