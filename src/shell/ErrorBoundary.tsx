import { Component, type ErrorInfo, type ReactNode } from "react";

/** The app's render safety net.
 *
 * React unmounts the WHOLE tree when a render throws and nothing catches it —
 * which, for a single-window desktop app, means a blank window with no text
 * and no way back except quitting. This boundary keeps the failure local: the
 * pane (or, at the root, the window) says what happened and offers a way on.
 *
 * `scope` names what died, so a chat crash doesn't read as "the app is gone".
 * `root` swaps the inline pane note for the full-window recovery card. */
export default class ErrorBoundary extends Component<
  { children: ReactNode; scope: string; root?: boolean },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The app captures no logs, so the console is the only record a support
    // conversation can reach for.
    console.error(`[${this.props.scope}] render failed:`, error, info.componentStack);
  }

  retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const detail = error.message || String(error);

    if (this.props.root) {
      return (
        <div className="crash-screen" role="alert">
          <div className="crash-card">
            <h2>Something went wrong</h2>
            {/* A render boundary sees an exception and nothing else. The throw
                can follow a save, a trash or a job start that already landed,
                so "nothing was written" is a claim this class cannot make. */}
            <p>
              Arcelle hit an unexpected error while drawing the window. Your
              room is an encrypted file on this Mac and is still there. Anything
              already saved is saved; unsaved work in the editor is gone.
            </p>
            <pre className="crash-detail">{detail}</pre>
            <div className="crash-actions">
              {/* Only one door. Retrying re-renders the same props from the same
                  store, so at the root it lands on the same throw. */}
              <button className="primary" onClick={() => window.location.reload()}>
                Reload Arcelle
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="crash-pane" role="alert">
        <p>
          <strong>{this.props.scope} couldn't be drawn.</strong> The rest of the
          app is still working.
        </p>
        <pre className="crash-detail">{detail}</pre>
        <button className="subtle" onClick={this.retry}>
          Try again
        </button>
      </div>
    );
  }
}
