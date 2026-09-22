import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error?: Error };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error boundary', {
      name: error.name,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="fatal-state" role="alert">
          <p className="eyebrow">Jupiter · Recovery</p>
          <h1>The interface could not load.</h1>
          <p>{this.state.error.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload the interface
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
