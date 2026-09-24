import { invoke } from '@tauri-apps/api/core';
import type { SavedCommand } from '../types';
import { isTauriRuntime } from './runtime';

const validIcons = new Set<SavedCommand['icon']>(['disk', 'box', 'file', 'network']);
const browserStorageKey = 'agent-ssh-commands-v1';

function isSavedCommand(value: unknown): value is SavedCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<SavedCommand>;
  return typeof command.id === 'string'
    && typeof command.name === 'string'
    && typeof command.command === 'string'
    && typeof command.category === 'string'
    && validIcons.has(command.icon as SavedCommand['icon']);
}

export async function loadClientCommands(): Promise<SavedCommand[] | null> {
  if (!isTauriRuntime()) {
    const stored = localStorage.getItem(browserStorageKey);
    if (!stored) return null;
    const commands: unknown = JSON.parse(stored);
    return Array.isArray(commands) ? commands.filter(isSavedCommand) : null;
  }
  const commands = await invoke<unknown[] | null>('load_commands');
  return commands?.filter(isSavedCommand) ?? null;
}

export async function saveClientCommands(commands: SavedCommand[]): Promise<void> {
  if (!isTauriRuntime()) {
    localStorage.setItem(browserStorageKey, JSON.stringify(commands));
    return;
  }
  await invoke('save_commands', { commands });
}
