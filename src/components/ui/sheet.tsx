'use client';

import * as React from 'react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]',
        'data-[state=open]:animate-sheet-overlay-in data-[state=closed]:animate-sheet-overlay-out',
        className
      )}
      {...props}
    />
  );
}

/**
 * Side sheet built on radix Dialog, so the focus trap and Escape handling stay
 * the same as a dialog; only the presentation and slide animation differ.
 */
function SheetContent({
  className,
  overlayClassName,
  children,
  side = 'left',
  hideClose = false,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'left' | 'right';
  overlayClassName?: string;
  hideClose?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 z-50 flex w-3/4 max-w-sm flex-col border bg-background text-foreground shadow-xl outline-none',
          side === 'left'
            ? 'left-0 border-r data-[state=open]:animate-sheet-in-left data-[state=closed]:animate-sheet-out-left'
            : 'right-0 border-l data-[state=open]:animate-sheet-in-right data-[state=closed]:animate-sheet-out-right',
          className
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <SheetPrimitive.Close
            className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <X className="size-4" />
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-lg font-semibold leading-tight', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetTitle,
  SheetDescription,
};
