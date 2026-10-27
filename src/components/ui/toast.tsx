"use client"

import * as React from "react"
import { CircleAlert, CircleCheck, Info, X } from "lucide-react"

import { cn } from "@/lib/utils"

type ToastVariant = "default" | "success" | "error"

interface ToastItem {
  id: number
  title: string
  description?: string
  variant: ToastVariant
}

interface ToastOptions {
  description?: string
  variant?: ToastVariant
  /** milliseconds; 0 keeps it until dismissed */
  duration?: number
}

interface ToastContextValue {
  toast: (title: string, options?: ToastOptions) => void
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

/** Lightweight toast stack (bottom-right on desktop, bottom-center on phones). */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([])
  const nextId = React.useRef(1)

  const dismiss = React.useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = React.useCallback(
    (title: string, options: ToastOptions = {}) => {
      const id = nextId.current++
      const item: ToastItem = { id, title, description: options.description, variant: options.variant ?? "default" }
      setItems((prev) => [...prev.slice(-3), item])
      const duration = options.duration ?? (item.variant === "error" ? 7000 : 4000)
      if (duration > 0) setTimeout(() => dismiss(id), duration)
    },
    [dismiss]
  )

  const value = React.useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-end sm:p-4"
      >
        {items.map((t) => {
          const Icon = t.variant === "error" ? CircleAlert : t.variant === "success" ? CircleCheck : Info
          return (
            <div
              key={t.id}
              role={t.variant === "error" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg",
                t.variant === "error" && "border-destructive/40",
                t.variant === "success" && "border-success/40"
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  t.variant === "error" ? "text-destructive" : t.variant === "success" ? "text-success" : "text-primary"
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t.title}</div>
                {t.description && <div className="mt-0.5 break-words text-xs text-muted-foreground">{t.description}</div>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Dismiss notification"
              >
                <X className="size-4" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

/** Returns a toast function; falls back to console when no provider is mounted. */
export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext)
  return ctx ?? { toast: (title, options) => console.warn("[toast]", title, options?.description ?? "") }
}
