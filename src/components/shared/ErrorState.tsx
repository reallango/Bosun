import { TriangleAlert } from 'lucide-react';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-4 py-8 text-center">
      <TriangleAlert className="mb-3 size-10 text-destructive" aria-hidden />
      <p className="max-w-md break-words text-sm text-destructive">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-4 rounded text-sm text-primary hover:underline">
          Try again
        </button>
      )}
    </div>
  );
}
