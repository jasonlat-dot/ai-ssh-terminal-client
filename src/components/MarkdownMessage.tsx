import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { prepareAssistantMarkdown } from '../state/assistantMarkdown';
import './MarkdownMessage.css';

/** Shared by top-level replies, sub-agents and historical replies. Raw HTML is not executed. */
export const MarkdownMessage = memo(function MarkdownMessage({ children }: { children: string }) {
  const [source, setSource] = useState(false);
  const markdown = useMemo(() => prepareAssistantMarkdown(children), [children]);
  return <div className="markdown-message">
    <div className="markdown-body">{source ? <pre className="markdown-source">{children}</pre> : <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: text, href, title }) => <a href={href} title={title} target="_blank" rel="noreferrer">{text}</a>,
      }}
    >{markdown}</ReactMarkdown>}</div>
    <button type="button" className="markdown-source-toggle" aria-pressed={source} onClick={() => setSource(value => !value)}>
      {source ? '返回排版' : '查看原文'}
    </button>
  </div>;
});
