/** One owner is registered at a time: the visible, focused terminal pane. */
export type TerminalCommand = {
  id: string;
  label: string;
  group: 'clipboard' | 'font' | 'completion' | 'connection';
  shortcut?: string;
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
  run: () => void | Promise<void>;
};
export type TerminalTarget = { owner: object; title: string; fontSize: number; commands: TerminalCommand[] };

export function createTerminalActions() {
  let target: TerminalTarget | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  return {
    getSnapshot: () => target,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(next: TerminalTarget) { target = next; emit(); },
    clear(owner: object) { if (target?.owner === owner) { target = null; emit(); } },
    run(owner: object, id: string) {
      if (target?.owner !== owner) return false;
      const command = target.commands.find(item => item.id === id);
      if (!command || command.disabled) return false;
      void command.run();
      return true;
    },
  };
}
