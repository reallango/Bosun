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

/**
 * Buttons of a toolbar (a `buttons` block and the dialog-form triggers above a view) share one height, padding and font
 * size so they line up. Exactly one may be solid (the primary look); the rest are outlined, and a destructive action gets
 * the outlined destructive look. Screens and pages use the large set, widget-sized toolbars the small one.
 */
export const TOOLBAR_BUTTON_SIZE = {
  large: 'inline-flex h-8 items-center justify-center gap-1 rounded-md px-3 text-sm font-medium disabled:opacity-40',
  small: 'inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium disabled:opacity-40',
} as const;

export type ToolbarButtonVariant = 'primary' | 'outline' | 'destructive';

const TOOLBAR_PRIMARY = 'bg-primary text-primary-foreground hover:bg-primary/90';
const TOOLBAR_OUTLINE = 'border border-border bg-transparent hover:bg-muted';
const TOOLBAR_DESTRUCTIVE = 'border border-destructive/50 text-destructive hover:bg-destructive/10';

export function toolbarButtonClass(size: 'large' | 'small', variant: ToolbarButtonVariant): string {
  const look = variant === 'primary' ? TOOLBAR_PRIMARY : variant === 'destructive' ? TOOLBAR_DESTRUCTIVE : TOOLBAR_OUTLINE;
  return `${TOOLBAR_BUTTON_SIZE[size]} ${look}`;
}

const submitButtonClass = 'inline-flex items-center gap-1 rounded-md px-3 py-1.5 font-medium disabled:opacity-40';

/** Solid submit button of an editor. */
export const primarySubmitClass = `${submitButtonClass} bg-primary text-primary-foreground hover:bg-primary/90`;
// A fixed red-600 rather than the destructive token: in dark mode that token (#ef4444) under white text is ~3.8:1, below WCAG AA.
export const dangerSubmitClass = `${submitButtonClass} bg-red-600 text-white hover:bg-red-700`;

/** Notice boxes, by level. Green and amber keep their fixed status colours. */
export const NOTICE_CLASS = {
  info: 'border-primary/30 bg-primary/10 text-primary',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
} as const;

/** The dialog shell shared by screen dialogs and forms that open behind a button. */
export const DIALOG_OVERLAY = 'fixed inset-0 z-50 bg-black/50';

export const DIALOG_CONTENT =
  'fixed inset-x-2 top-4 z-50 mx-auto flex max-h-[92vh] flex-col rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl';

export const DIALOG_WIDTH: Record<string, string> = { md: 'sm:max-w-lg', lg: 'sm:max-w-3xl', xl: 'sm:max-w-5xl' };

export const DIALOG_HEADER = 'mb-3 flex items-start justify-between gap-2';

export const DIALOG_TITLE = 'min-w-0 truncate text-base font-semibold';

export const DIALOG_FOOTER = 'mt-3 flex flex-wrap justify-end gap-2 border-t border-border pt-3';
