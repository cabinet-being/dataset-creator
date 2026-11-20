import React from 'react';

type State = { error: Error | null };

/** Replaces a crashed React tree with a small recovery panel instead of a white screen. */
export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[app] render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ margin: '10vh auto', maxWidth: 480, padding: 24, borderRadius: 8, border: '1px solid #7f1d1d', background: '#1c1917', color: '#fafaf9', fontFamily: 'sans-serif' }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Something went wrong</h2>
        <p style={{ margin: '0 0 16px', fontSize: 14, wordBreak: 'break-word', opacity: 0.8 }}>{error.message}</p>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '6px 14px', borderRadius: 6, border: 0, background: '#e7e5e4', color: '#1c1917', cursor: 'pointer' }}>Reload</button>
      </div>
    );
  }
}
