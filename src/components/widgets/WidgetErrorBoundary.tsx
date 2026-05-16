'use client';

import { Component, ReactNode } from 'react';

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
      return (
        <div className="flex flex-col items-center justify-center h-full p-4 text-center">
          <div className="text-red-500 mb-2">Widget Error</div>
          <div className="text-sm text-gray-500 mb-3">{this.state.error?.message}</div>
          <button onClick={this.handleRetry} className="px-3 py-1 text-sm border rounded hover:bg-gray-50">
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}