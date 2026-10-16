import type { ButtonHTMLAttributes } from 'react';
import { copyText } from '../state/clipboard';
import { ClipboardFeedback, useClipboardFeedback } from './ClipboardFeedback';
import { Icon } from './Ui';
import './CopyTextButton.css';

export type CopyButtonHint = Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onMouseEnter'|'onMouseLeave'|'onFocus'|'onBlur'|'aria-describedby'> & {onActivate?:()=>void};

/** Shared browser/Tauri clipboard action. getText returns the original text, never HTML. */
export function CopyTextButton({ getText, label = '复制文本', successMessage = '文本已复制', iconOnly = false, hint }: {
  getText: () => string;
  label?: string;
  successMessage?: string;
  iconOnly?: boolean;
  hint?: CopyButtonHint;
}) {
  const {onActivate,...hoverProps}=hint??{};
  const { feedback, showFeedback } = useClipboardFeedback();
  const copied = feedback?.kind === 'success';
  const copy = async () => {
    try { await copyText(getText()); showFeedback(successMessage); }
    catch { showFeedback('复制失败，请重试', 'error'); }
  };
  return <span className="markdown-copy-control"><button type="button" className={`copy-markdown-button ${copied ? 'copied' : ''}${iconOnly ? ' is-icon-only' : ''}`} {...hoverProps} aria-label={copied ? '已复制' : label} title={hint?undefined:copied ? '已复制' : label}
    onClick={event => { event.preventDefault(); event.stopPropagation(); onActivate?.(); void copy(); }}>
    <Icon name={copied ? 'check' : 'copy'} size={13} />
    {!iconOnly && <span className="copy-button-label" aria-hidden="true"><span className="copy-label-default">{label}</span><span className="copy-label-success">已复制</span></span>}
  </button>
    <span className="visually-hidden" role="status" aria-live="polite">{copied ? feedback.message : ''}</span>
    <ClipboardFeedback feedback={feedback?.kind === 'error' ? feedback : null} />
  </span>;
}
