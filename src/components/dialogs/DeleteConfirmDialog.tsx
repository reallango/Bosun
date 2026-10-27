'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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

export function DeleteConfirmDialog({ widgetTitle, open, onOpenChange, onConfirm, loading, title, confirmLabel }: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" role="alertdialog">
        <DialogHeader>
          <DialogTitle>{title ?? 'Remove widget?'}</DialogTitle>
          <DialogDescription>
            Are you sure you want to remove <strong className="text-foreground">{widgetTitle}</strong>? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="lg"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
            disabled={loading}
          >
            {loading ? 'Removing…' : confirmLabel ?? 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
