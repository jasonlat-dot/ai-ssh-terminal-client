import { copyText } from '../state/clipboard';
import { ClipboardFeedback, useClipboardFeedback } from './ClipboardFeedback';
import { Icon } from './Ui';

/** Shared browser/Tauri clipboard action. getText returns the original text, never HTML. */
export function CopyTextButton({ getText, label = '复制文本', successMessage = '文本已复制' }: {
  getText: () => string;
  label?: string;
  successMessage?: string;
}) {
  const { feedback, showFeedback } = useClipboardFeedback();
  const copy = async () => {
    try { await copyText(getText()); showFeedback(successMessage); }
    catch { showFeedback('复制失败，请重试', 'error'); }
  };
  return <span className="markdown-copy-control"><button type="button" className="copy-markdown-button" title={label} aria-label={label}
    onClick={event => { event.preventDefault(); event.stopPropagation(); void copy(); }}>
    <Icon name={feedback?.kind === 'success' ? 'check' : 'copy'} size={13} /><span>{label}</span>
  </button><ClipboardFeedback feedback={feedback} /></span>;
}
