"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close
const DialogPortal = DialogPrimitive.Portal

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]", className)}
      {...props}
    />
  )
}

/** The one size scale every dialog uses. Below `sm` a dialog fills the screen. */
const DIALOG_SIZES = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-3xl",
  xl: "sm:max-w-5xl",
} as const

/**
 * Responsive dialog: full screen on phones, a centered card from `sm` up.
 * Put the scrolling content in `DialogBody` and the actions in `DialogFooter`;
 * the body scrolls while the header and footer stay in view.
 */
function DialogContent({
  className,
  children,
  hideClose = false,
  size = "md",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  hideClose?: boolean
  size?: keyof typeof DIALOG_SIZES
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed z-50 flex flex-col gap-4 overflow-hidden border bg-popover text-popover-foreground shadow-xl outline-none",
          // phone: full screen
          "inset-0 h-[100dvh] max-h-none rounded-none p-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
          // sm+: centered card
          "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:w-[calc(100%-2rem)] sm:max-h-[85dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:p-6",
          DIALOG_SIZES[size],
          className
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-1 pr-8", className)} {...props} />
}

/** Scrollable middle section of a dialog. */
const DialogBody = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function DialogBody({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="dialog-body"
        className={cn("-mx-4 min-h-0 flex-1 overflow-y-auto px-4 sm:-mx-6 sm:px-6", className)}
        {...props}
      />
    )
  }
)

/**
 * Sticky action row. It stays at the bottom while `DialogBody` scrolls, and a
 * dialog screen can portal an editor's submit buttons into it.
 */
const DialogFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function DialogFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="dialog-footer"
        className={cn(
          "sticky bottom-0 z-10 -mx-4 -mb-4 mt-auto flex flex-col-reverse gap-2 border-t bg-popover px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-6 sm:-mb-6 sm:flex-row sm:justify-end sm:px-6 sm:py-4 [&>*]:w-full sm:[&>*]:w-auto",
          className
        )}
        {...props}
      />
    )
  }
)

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-semibold leading-tight", className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
