import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './runtime';

export async function readClipboardText(): Promise<string> {
  if (isTauriRuntime()) return invoke<string>('plugin:clipboard-manager|read_text');
  if (!navigator.clipboard?.readText) throw new Error('请使用系统粘贴快捷键。');
  return navigator.clipboard.readText();
}

/** Copy plain text/Markdown, including WebViews without the async clipboard API. */
export async function copyText(text: string): Promise<void> {
  try {
    if (isTauriRuntime()) {
      await invoke('plugin:clipboard-manager|write_text', { text });
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // A restricted WebView may still support copying from a selected textarea.
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error('复制失败，请选中文本后使用系统复制。');
  } finally {
    field.remove();
    previousFocus?.focus({ preventScroll: true });
    selection?.removeAllRanges();
    ranges.forEach(range => selection?.addRange(range));
  }
}
