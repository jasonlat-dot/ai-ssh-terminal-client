import type { ComponentProps } from 'react';
import type ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';

type MarkdownProps = ComponentProps<typeof ReactMarkdown>;
export const assistantRemarkPlugins: NonNullable<MarkdownProps['remarkPlugins']> = [remarkGfm, remarkMath];
const math: NonNullable<MarkdownProps['rehypePlugins']> = [[rehypeKatex, {
  // 回复文本不可信：禁止公式导入网络图片、注入 HTML、创建任意链接。
  trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20,
}]];
const highlight: NonNullable<MarkdownProps['rehypePlugins']> = [[rehypeHighlight, {
  detect: false, plainText: ['text', 'plaintext', 'txt', 'log'],
}]];

/** 主 Agent、子 Agent 与历史回复使用同一配置；流式输出只延后代码高亮，不关闭公式。 */
export function assistantRehypePlugins(streaming: boolean, length: number): NonNullable<MarkdownProps['rehypePlugins']> {
  return !streaming && length <= 50_000 ? [...math, ...highlight] : math;
}
