'use client';

import { useParams } from 'next/navigation';
import { ScreenPage } from '@/components/widgets/declarative/ScreenPage';

/** A full-page screen declared by a widget package (for example a Docker "Manage" page). */
export default function WidgetScreenRoute() {
  const { widgetId, screenId } = useParams<{ widgetId: string; screenId: string }>();
  return <ScreenPage widgetId={widgetId} screenId={screenId} />;
}
