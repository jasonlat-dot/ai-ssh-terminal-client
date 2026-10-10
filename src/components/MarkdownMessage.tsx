import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { renderableAssistantMarkdown } from '../state/assistantMarkdown';
import { assistantRehypePlugins, assistantRemarkPlugins } from '../state/assistantMarkdownPlugins';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { CopyTextButton } from './CopyTextButton';
// 使用与 rehype-katex 同版本的本地 CSS/字体，桌面离线运行也能排版公式。
import 'katex/dist/katex.min.css';
import './MarkdownMessage.css';

/** Shared by top-level replies, sub-agents and historical replies. Raw HTML is not executed. */
export const MarkdownMessage = memo(function MarkdownMessage({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const [source, setSource] = useState(false);
  const markdown = useMemo(() => renderableAssistantMarkdown(children, streaming), [children, streaming]);
  const components = useMemo<Components>(() => ({
    a: ({ children: text, href, title }) => href ? <a href={href} title={title} target="_blank" rel="noreferrer">{text}</a> : <span>{text}</span>,
    pre: props => <MarkdownCodeBlock {...props} streaming={streaming} />,
  }), [streaming]);
  return <div className="markdown-message">
    <div className="markdown-body">{source ? <pre className="markdown-source">{children}</pre> : <ReactMarkdown
      remarkPlugins={assistantRemarkPlugins}
      // Highlight once the reply finishes; avoid reparsing grammars on each
      // token. Large logs stay plain text to keep the terminal responsive.
      rehypePlugins={assistantRehypePlugins(streaming, markdown.length)}
      components={components}
    >{markdown}</ReactMarkdown>}</div>
    <div className="markdown-source-actions">
      {source && !streaming && <CopyTextButton getText={() => children} label="复制原文" />}
      <button type="button" className="markdown-source-toggle" aria-pressed={source} onClick={() => setSource(value => !value)}>
        {source ? '返回排版' : '查看原文'}
      </button>
    </div>
  </div>;
});
