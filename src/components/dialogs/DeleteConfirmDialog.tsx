'use client';

import { Button } from '@/components/ui/button';

interface DeleteConfirmDialogProps {
  widgetTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  loading?: boolean;
}

export function DeleteConfirmDialog({ widgetTitle, open, onOpenChange, onConfirm, loading }: DeleteConfirmDialogProps) {
  if (!open) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 w-full max-w-sm mx-4">
        <h2 className="text-lg font-semibold mb-2">Remove Widget?</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Are you sure you want to remove <strong>{widgetTitle}</strong>? 
          This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button 
            variant="destructive"
            onClick={() => { onOpenChange(false); onConfirm(); }}
            disabled={loading}
          >
            {loading ? 'Removing...' : 'Remove'}
          </Button>
        </div>
      </div>
    </div>
  );
}