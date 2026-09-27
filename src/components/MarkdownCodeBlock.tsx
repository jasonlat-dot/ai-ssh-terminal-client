import { useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import type { ExtraProps } from 'react-markdown';
import { copyText } from '../state/clipboard';
import { ClipboardFeedback, useClipboardFeedback } from './ClipboardFeedback';
import { Icon } from './Ui';

type TextNode = { type: string; value?: string; children?: TextNode[] };
function codeText(node: TextNode): string {
  return node.type === 'text' ? node.value ?? '' : node.children?.map(codeText).join('') ?? '';
}

export function MarkdownCodeBlock({ node, children, streaming, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps & { streaming: boolean }) {
  const [wrap, setWrap] = useState(false);
  const { feedback, showFeedback } = useClipboardFeedback();
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  const classes = code?.type === 'element' ? code.properties.className : undefined;
  const language = (Array.isArray(classes) ? classes : []).map(String).find(name => name.startsWith('language-'))?.slice(9) || 'text';
  const text = code ? codeText(code).replace(/\n$/, '') : '';
  const copy = async () => {
    try { await copyText(text); showFeedback('代码已复制'); }
    catch { showFeedback('复制失败，请重试', 'error'); }
  };
  return <div className={`markdown-code-card ${wrap ? 'wrap' : ''}`}>
    <div className="markdown-code-toolbar">
      <span className="markdown-code-language"><Icon name="terminal" size={13} />{language === 'text' || language === 'plaintext' ? '纯文本' : language}</span>
      <div className="markdown-code-actions">
        <button type="button" aria-pressed={wrap} onClick={() => setWrap(value => !value)} title={wrap ? '关闭自动换行' : '开启自动换行'}>换行</button>
        {streaming ? <span className="markdown-code-streaming">生成中</span> : <span className="markdown-code-copy">
          <button type="button" onClick={() => { void copy(); }} title="复制代码" aria-label="复制代码"><Icon name={feedback?.kind === 'success' ? 'check' : 'copy'} size={13} />复制</button>
          <ClipboardFeedback feedback={feedback} />
        </span>}
      </div>
    </div>
    <pre {...props} tabIndex={0} aria-label={`${language} 代码`}>{children}</pre>
  </div>;
}
