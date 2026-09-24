import { invoke } from '@tauri-apps/api/core';
import type { SavedCommand } from '../types';

const validIcons = new Set<SavedCommand['icon']>(['disk', 'box', 'file', 'network']);

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
  const commands = await invoke<unknown[] | null>('load_commands');
  return commands?.filter(isSavedCommand) ?? null;
}

export async function saveClientCommands(commands: SavedCommand[]): Promise<void> {
  await invoke('save_commands', { commands });
}
