import { renderToPipeableStream } from 'react-dom/server';
import App from './App.jsx';

/**
 * Renders the App into `destination` (a Node.js Writable).
 * Streaming starts as soon as the shell is ready (no Suspense boundaries
 * in this app, so that happens on the first microtask after this call).
 *
 * Returns `abort` — call it to cancel the render (e.g. on client disconnect).
 */
export function render(initialState, destination) {
  const { pipe, abort } = renderToPipeableStream(
    <App initialState={initialState} />,
    {
      onShellReady()    { pipe(destination); },
      onShellError(err) {
        console.error('[ssr] Shell render error:', err);
        destination.destroy(err);
      },
      onError(err)      { console.error('[ssr]', err); },
    }
  );
  return abort;
}
