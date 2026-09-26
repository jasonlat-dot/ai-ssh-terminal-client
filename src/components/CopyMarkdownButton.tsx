import { useEffect, useRef, useState } from 'react';
import { copyText } from '../state/clipboard';
import { Icon } from './Ui';

export function CopyMarkdownButton({ getText, label = '复制 Markdown' }: { getText: () => string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try { await copyText(getText()); setStatus('copied'); }
    catch { setStatus('failed'); }
    timer.current = setTimeout(() => setStatus('idle'), 2200);
  };
  const text = status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请重试' : label;
  return <button type="button" className={`copy-markdown-button ${status}`} title={text} aria-label={text}
    onClick={event => { event.stopPropagation(); void copy(); }}>
    <Icon name={status === 'copied' ? 'check' : 'copy'} size={13} /><span aria-live="polite">{text}</span>
  </button>;
}
