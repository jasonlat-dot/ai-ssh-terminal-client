import { memo, useMemo, useState } from 'react';
import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { renderableAssistantMarkdown } from '../state/assistantMarkdown';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { CopyTextButton } from './CopyTextButton';
import './MarkdownMessage.css';

const highlight: NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [[rehypeHighlight, { detect: false, plainText: ['text', 'plaintext', 'txt', 'log'] }]];

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
      remarkPlugins={[remarkGfm]}
      // Highlight once the reply finishes; avoid reparsing grammars on each
      // token. Large logs stay plain text to keep the terminal responsive.
      rehypePlugins={!streaming && markdown.length <= 50_000 ? highlight : []}
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
