import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { loadManifest, type Manifest } from './lib/manifest';
import { Shell } from './Shell';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fullscreen-msg">
          <h1>Something went wrong</h1>
          <p>{this.state.error.message}</p>
          <p className="dim">If this mentions WebGL, enable hardware acceleration in your browser.</p>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    loadManifest(undefined, ctl.signal)
      .then(setManifest)
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctl.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (error) {
    return (
      <div className="fullscreen-msg">
        <h1>Couldn’t load the map</h1>
        <p>{error}</p>
        <button onClick={retry}>Try again</button>
      </div>
    );
  }
  if (!manifest) return <div className="fullscreen-msg">Loading map…</div>;
  return (
    <ErrorBoundary>
      <Shell manifest={manifest} />
    </ErrorBoundary>
  );
}
