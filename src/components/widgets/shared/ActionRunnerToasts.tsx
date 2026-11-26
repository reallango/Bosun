'use client';

import { useEffect, useRef } from 'react';
import { useToast } from '@/components/ui/toast';
import { noticeToastVariant } from './screen-page';

interface Props {
  /** The action runner's latest message (a started job, a result, a failure). */
  notice: string | null;
  /** Called once the message is shown, so the runner can drop it. */
  onShown: () => void;
}

/** Shows a page's action results and errors as toasts instead of a strip inside the page. */
export function ActionRunnerToasts({ notice, onShown }: Props) {
  const { toast } = useToast();
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!notice) {
      shown.current = null;
      return;
    }
    if (shown.current === notice) return;
    shown.current = notice;
    toast(notice, { variant: noticeToastVariant(notice) });
    onShown();
  }, [notice, onShown, toast]);

  return null;
}
