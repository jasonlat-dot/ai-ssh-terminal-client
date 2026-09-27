import { copyText } from '../state/clipboard';
import { ClipboardFeedback, useClipboardFeedback } from './ClipboardFeedback';
import { Icon } from './Ui';
import './CopyTextButton.css';

/** Shared browser/Tauri clipboard action. getText returns the original text, never HTML. */
export function CopyTextButton({ getText, label = '复制文本', successMessage = '文本已复制' }: {
  getText: () => string;
  label?: string;
  successMessage?: string;
}) {
  const { feedback, showFeedback } = useClipboardFeedback();
  const copied = feedback?.kind === 'success';
  const copy = async () => {
    try { await copyText(getText()); showFeedback(successMessage); }
    catch { showFeedback('复制失败，请重试', 'error'); }
  };
  return <span className="markdown-copy-control"><button type="button" className={`copy-markdown-button ${copied ? 'copied' : ''}`} aria-label={copied ? '已复制' : label}
    onClick={event => { event.preventDefault(); event.stopPropagation(); void copy(); }}>
    <Icon name={copied ? 'check' : 'copy'} size={13} />
    <span className="copy-button-label" aria-hidden="true"><span className="copy-label-default">{label}</span><span className="copy-label-success">已复制</span></span>
  </button>
    <span className="visually-hidden" role="status" aria-live="polite">{copied ? feedback.message : ''}</span>
    <ClipboardFeedback feedback={feedback?.kind === 'error' ? feedback : null} />
  </span>;
}
