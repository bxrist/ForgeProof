import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Error caught by boundary:", error, errorInfo);
  }

  handleRefresh = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          data-testid="error-boundary-fallback"
          className="flex items-center justify-center min-h-screen bg-background text-foreground dark:bg-background dark:text-foreground"
        >
          <div className="text-center px-6 py-8 max-w-md">
            {/* Warning Icon */}
            <div className="flex justify-center mb-6">
              <svg
                className="w-16 h-16 text-destructive"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 9v2m0 4v2m0 0v2M6.343 6.343L7.757 7.757m5.486-5.486L13.172 3.172m7.071 7.071l-1.414 1.414m-5.486 5.486l1.414 1.414M3 12a9 9 0 1118 0 9 9 0 01-18 0z"
                />
              </svg>
            </div>

            {/* Heading */}
            <h1 className="text-3xl font-bold mb-3">Something went wrong</h1>

            {/* Description */}
            <p className="text-muted-foreground mb-8">
              An unexpected error occurred. Please try refreshing the page.
            </p>

            {/* Buttons */}
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <button
                onClick={this.handleRefresh}
                data-testid="button-refresh-page"
                className="px-6 py-2.5 bg-primary text-primary-foreground rounded-md font-medium hover:bg-primary/90 active:bg-primary/80 transition-colors"
              >
                Refresh Page
              </button>
              <a
                href="/"
                data-testid="link-go-home"
                className="px-6 py-2.5 border border-input bg-background text-foreground rounded-md font-medium hover:bg-accent active:bg-accent/80 transition-colors inline-block"
              >
                Go Home
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
