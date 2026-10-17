import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { highlightJson } from '../state/jsonHighlight';
import './JsonCodeEditor.css';

type Props = { id: string; label: string; describedBy?: string; value: string; onChange: (value: string) => void; disabled?: boolean; invalid?: boolean };
function syncEditorLayers(input: HTMLTextAreaElement | null, preview: HTMLPreElement | null, gutter: HTMLPreElement | null) {
  if (!input) return;
  if (preview) {
    // Match the native text viewport, excluding either scrollbar, before copying offsets.
    preview.style.width = `${input.clientWidth}px`;
    preview.style.height = `${input.clientHeight}px`;
    preview.scrollTop = input.scrollTop;
    preview.scrollLeft = input.scrollLeft;
  }
  if (gutter) {
    gutter.style.height = `${input.clientHeight}px`;
    gutter.scrollTop = input.scrollTop;
  }
}
export function JsonCodeEditor({ id, label, describedBy, value, onChange, disabled = false, invalid = false }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const preview = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const [composing, setComposing] = useState(false);
  const tokens = useMemo(() => highlightJson(value), [value]);
  const lines = useMemo(() => Array.from({ length: value.split('\n').length }, (_, index) => index + 1).join('\n'), [value]);
  useLayoutEffect(() => { syncEditorLayers(input.current, preview.current, gutter.current); }, [value]);
  useLayoutEffect(() => {
    if (!input.current) return;
    const observer = new ResizeObserver(() => syncEditorLayers(input.current, preview.current, gutter.current));
    observer.observe(input.current);
    return () => observer.disconnect();
  }, []);
  return <div className={`json-code-editor${composing ? ' is-composing' : ''}${disabled ? ' is-disabled' : ''}`} data-invalid={invalid || undefined}>
    <pre className="json-code-gutter" aria-hidden="true" ref={gutter}>{lines}</pre>
    <div className="json-code-surface">
      <pre className="json-code-highlight" aria-hidden="true" ref={preview}><code>{tokens.map((token, index) => <span className={`json-token-${token.type}`} key={index}>{token.text}</span>)}{'\n'}</code></pre>
      <textarea ref={input} id={id} aria-label={label} aria-describedby={describedBy} aria-invalid={invalid} data-autofocus value={value} disabled={disabled} spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" wrap="off" onChange={event => onChange(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onScroll={event => syncEditorLayers(event.currentTarget, preview.current, gutter.current)} />
    </div>
  </div>;
}
