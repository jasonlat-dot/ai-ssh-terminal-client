import type { ModelConfig } from '../api/models';
import { parseModelIds } from './modelChannels';

export function selectedModelIds(text: string, provider: ModelConfig['provider']): string[] {
  return [...new Set(text.split(/[\r\n,，]+/).map(id => id.trim()).filter(Boolean)
    .map(id => provider === 'googleGemini' ? id.replace(/^models\//, '') : id))];
}
/** Additions never replace manual selections or silently truncate a bulk choice. */
export function addModelIds(text: string, additions: string[], provider: ModelConfig['provider']): string {
  const ids = selectedModelIds([text, ...additions].join('\n'), provider);
  return parseModelIds(ids.join('\n')).join('\n');
}
