import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createTerminalActions } from '../state/terminalActions';
import type { TerminalTarget } from '../state/terminalActions';

const Context = createContext<ReturnType<typeof createTerminalActions> | null>(null);
export function TerminalActionsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createTerminalActions);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTerminalActions() {
  const store = useContext(Context);
  if (!store) throw new Error('TerminalActionsProvider is missing');
  return store;
}
export function useTerminalTarget(enabled: boolean, target: Omit<TerminalTarget, 'owner'>) {
  const store = useTerminalActions();
  const owner = useRef<object>({});
  // Clear only this owner; a late cleanup must never clear another split pane.
  useLayoutEffect(() => () => store.clear(owner.current), [store, enabled]);
  useLayoutEffect(() => {
    if (enabled) store.publish({ ...target, owner: owner.current });
  });
}
