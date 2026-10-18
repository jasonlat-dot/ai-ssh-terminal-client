import { useEffect, useState } from 'react';

export const STARTUP_EXIT_MS = 220;

/** A failed readiness check cancels the fade, including its admission timer. */
export function useStartupTransition(ready: boolean, desktop: boolean) {
  const [entered, setEntered] = useState(!desktop);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (!ready) {
      setEntered(false);
      setExiting(false);
      return;
    }
    if (entered) return;
    setExiting(true);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(() => setEntered(true), reduced ? 0 : STARTUP_EXIT_MS);
    return () => clearTimeout(timer);
  }, [ready, entered]);
  return { entered: ready && entered, exiting: ready && !entered && exiting };
}
