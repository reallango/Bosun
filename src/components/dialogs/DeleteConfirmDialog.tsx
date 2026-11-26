'use client';

import { ConfirmActionDialog } from '@/components/widgets/shared/ConfirmActionDialog';

interface DeleteConfirmDialogProps {
  widgetTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  loading?: boolean;
  /** Override the default "Remove Widget?" wording. */
  title?: string;
  confirmLabel?: string;
}

/** The Remove/Delete confirmation around the app, on top of the shared confirm dialog. */
export function DeleteConfirmDialog({ widgetTitle, open, onOpenChange, onConfirm, loading, title, confirmLabel }: DeleteConfirmDialogProps) {
  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? 'Remove widget?'}
      description={(
        <>
          Are you sure you want to remove <strong className="text-foreground">{widgetTitle}</strong>? This action cannot be undone.
        </>
      )}
      confirmLabel={loading ? 'Removing…' : confirmLabel ?? 'Remove'}
      destructive
      busy={loading}
      onConfirm={onConfirm}
    />
  );
}
