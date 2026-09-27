import { useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import type { ExtraProps } from 'react-markdown';
import { CopyTextButton } from './CopyTextButton';
import { Icon } from './Ui';

type TextNode = { type: string; value?: string; children?: TextNode[] };
function codeText(node: TextNode): string {
  return node.type === 'text' ? node.value ?? '' : node.children?.map(codeText).join('') ?? '';
}

export function MarkdownCodeBlock({ node, children, streaming, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps & { streaming: boolean }) {
  const [wrap, setWrap] = useState(false);
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  const classes = code?.type === 'element' ? code.properties.className : undefined;
  const language = (Array.isArray(classes) ? classes : []).map(String).find(name => name.startsWith('language-'))?.slice(9) || 'text';
  const text = code ? codeText(code).replace(/\n$/, '') : '';
  return <div className={`markdown-code-card ${wrap ? 'wrap' : ''}`}>
    <div className="markdown-code-toolbar">
      <span className="markdown-code-language"><Icon name="terminal" size={13} />{language === 'text' || language === 'plaintext' ? '纯文本' : language}</span>
      <div className="markdown-code-actions">
        <button type="button" aria-pressed={wrap} onClick={() => setWrap(value => !value)} title={wrap ? '关闭自动换行' : '开启自动换行'}>换行</button>
        {streaming && <span className="markdown-code-streaming">生成中</span>}
        <span className="markdown-code-copy">
          <CopyTextButton getText={() => text} label="复制文本" successMessage={streaming ? '已复制当前生成的代码文本' : '代码文本已复制'} />
        </span>
      </div>
    </div>
    <pre {...props} tabIndex={0} aria-label={`${language} 代码`}>{children}</pre>
  </div>;
}
