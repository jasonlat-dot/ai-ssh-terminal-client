import { copyText } from '../state/clipboard';
import { ClipboardFeedback, useClipboardFeedback } from './ClipboardFeedback';
import { Icon } from './Ui';

export function CopyMarkdownButton({ getText, label = '复制 Markdown' }: { getText: () => string; label?: string }) {
  const { feedback, showFeedback } = useClipboardFeedback();
  const copy = async () => {
    try { await copyText(getText()); showFeedback('已复制为 Markdown'); }
    catch { showFeedback('复制失败，请重试', 'error'); }
  };
  return <span className="markdown-copy-control"><button type="button" className="copy-markdown-button" title={label} aria-label={label}
    onClick={event => { event.stopPropagation(); void copy(); }}>
    <Icon name={feedback?.kind === 'success' ? 'check' : 'copy'} size={13} /><span>{label}</span>
  </button><ClipboardFeedback feedback={feedback} /></span>;
}
