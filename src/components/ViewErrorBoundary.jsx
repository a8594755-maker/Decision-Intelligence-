import React from 'react';
import { AlertCircle, RefreshCw, Home } from 'lucide-react';

/**
 * Per-view error boundary with contextual error messages.
 * Wraps individual views so one crash doesn't kill the whole app.
 *
 * Props:
 *   viewName - name of the view (for error message context)
 */
export default class ViewErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    const viewName = this.props.viewName || 'Unknown';
    console.error(`[ViewErrorBoundary:${viewName}] Caught error:`, error, errorInfo);

    // Report to Sentry if available
    import('@sentry/react')
      .then(Sentry => {
        Sentry.captureException(error, {
          extra: { viewName, componentStack: errorInfo?.componentStack },
        });
      })
      .catch(() => {
        // Sentry not available — ignore
      });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      const viewName = this.props.viewName || 'this';

      return (
        <div className="h-full flex items-center justify-center p-8">
          <div className="max-w-md w-full text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
              <AlertCircle className="w-8 h-8 text-red-600" />
            </div>
            <h2 className="text-xl font-bold mb-2">Something went wrong</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
              An error occurred in the <strong>{viewName}</strong> view.
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-6 font-mono">
              {this.state.error?.message || 'Unknown error'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleReset}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Try Again
              </button>
              <button
                onClick={this.handleGoHome}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 font-medium text-sm transition-colors"
              >
                <Home className="w-4 h-4" />
                Go Home
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
