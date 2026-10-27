'use client';

import { Component, ReactNode } from 'react';
import { WidgetError } from './WidgetError';

interface WidgetErrorBoundaryProps {
  children: ReactNode;
  widgetId: string;
}

interface WidgetErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  constructor(props: WidgetErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): WidgetErrorBoundaryState {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      return <WidgetError error={`Widget error: ${this.state.error?.message ?? 'unknown'}`} onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}
