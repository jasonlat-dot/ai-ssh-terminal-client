import { Channel, invoke } from '@tauri-apps/api/core';

export type LocalTerminalEvent =
  | { type: 'data'; data: number[] }
  | { type: 'exit' }
  | { type: 'error'; message: string };

export type LocalTerminalOpen = {
  sessionId: string;
  shell: string;
  cwd: string;
};

export const localTerminalApi = {
  open: (cols: number, rows: number, receive: (event: LocalTerminalEvent) => void) => {
    const onEvent = new Channel<LocalTerminalEvent>();
    onEvent.onmessage = receive;
    return invoke<LocalTerminalOpen>('local_terminal_open', { cols, rows, onEvent });
  },
  write: (sessionId: string, input: string) =>
    invoke<void>('local_terminal_write', { sessionId, input }),
  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>('local_terminal_resize', { sessionId, cols, rows }),
  close: (sessionId: string) =>
    invoke<void>('local_terminal_close', { sessionId }),
};
