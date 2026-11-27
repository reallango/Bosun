import { CircleAlert, CircleCheck, Info, KeyRound, PackageCheck, PackagePlus, TriangleAlert } from 'lucide-react';

export const TYPE_ICON = {
  error: { icon: CircleAlert, className: 'text-destructive' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  success: { icon: CircleCheck, className: 'text-success' },
  info: { icon: Info, className: 'text-primary' },
} as const;

/** Kinds with their own icon; everything else uses the severity icon. */
export const KIND_ICON: Record<string, { icon: typeof Info; className: string }> = {
  widget_update: { icon: PackagePlus, className: 'text-primary' },
  widget_upgraded: { icon: PackageCheck, className: 'text-success' },
  access_request: { icon: KeyRound, className: 'text-warning' },
};

export function notificationIcon(kind: string, type: string) {
  return KIND_ICON[kind] ?? TYPE_ICON[type as keyof typeof TYPE_ICON] ?? TYPE_ICON.info;
}
