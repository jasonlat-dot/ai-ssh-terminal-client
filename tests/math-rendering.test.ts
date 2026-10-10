import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { prepareAssistantMarkdown, renderableAssistantMarkdown } from '../src/state/assistantMarkdown.ts';
import { assistantRemarkPlugins, assistantRehypePlugins } from '../src/state/assistantMarkdownPlugins.ts';

/** 使用生产组件同一插件配置，验证最终 HTML，不只检查字符串是否替换。 */
function render(source: string, streaming = false) {
  const markdown = renderableAssistantMarkdown(source, streaming);
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: assistantRemarkPlugins,
    rehypePlugins: assistantRehypePlugins(streaming, markdown.length),
    children: markdown,
  }));
}

test('截图中的夹逼定理与极限、分数、上下标公式均成为 KaTeX 排版', () => {
  const source = String.raw`如果在某个去心邻域内有 \[g(x)\le f(x)\le h(x)\]

并且 \[\lim_{x\to a}g(x)=\lim_{x\to a}h(x)=L\]

那么 \[\lim_{x\to a}f(x)=L\]

例子 \[-x^2\le x^2\sin\frac{1}{x}\le x^2\]`;
  const html = render(source);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 4);
  assert.match(html, /<math[^>]*display="block"/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msup>/);
  assert.doesNotMatch(html, /katex-error/);
  assert.equal(source.includes(String.raw`\lim_{x\to a}`), true, '传入原回复不被修改');
});

test('支持行内与块级美元符号、LaTeX 括号，已有公式不会被二次改写', () => {
  const source = String.raw`行内 \(a_n\le b_n\le c_n\)，以及 $E=mc^2$。

$$
\lim_{n\to\infty} b_n=L
$$`;
  const html = render(source);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 1);
  const prepared = prepareAssistantMarkdown(source);
  assert.equal(prepareAssistantMarkdown(prepared), prepared);
  assert.ok(prepared.includes('$E=mc^2$'));
});

test('多行带缩进的 aligned/矩阵公式仍属于公式，数学围栏也可渲染', () => {
  const source = String.raw`\[
    \begin{aligned}
    a &= b + c \\
    d &= \frac{1}{2}
    \end{aligned}
\]

` + '```math\n\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}\n```';
  const html = render(source);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /katex-error/);
  assert.doesNotMatch(html, /<pre>/, 'math 围栏应是公式，不是 SSH 代码卡片');
});

test('代码块、行内代码、缩进代码、链接、转义括号和普通方括号保持原样', () => {
  for (const source of [
    '代码 `\\[x^2\\]`',
    '```bash\nprintf "\\[x^2\\]"\n```',
    '> ```text\n> \\[x\\]\n> ```',
    '    \\[x^2\\]\n\n\t\\(a+b\\)',
    String.raw`[link](https://example.test/\(path\))`,
    String.raw`字面值 \\[x\\]，普通 [a,b]`,
  ]) assert.equal(prepareAssistantMarkdown(source), source);
  assert.doesNotMatch(render('`\\[x^2\\]`'), /class="katex"/);
});

test('表格/引用中的公式不拆散 Markdown 结构', () => {
  const html = render(String.raw`| 条件 | 表达式 |
| --- | --- |
| 夹逼 | \[a\le b\le c\] |

> 条件 \[x^2\ge0\]`);
  assert.match(html, /<table>/);
  assert.match(html, /<blockquote>/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
});

test('未完成的流式公式不崩溃，闭合后主 Agent/子 Agent 同样渲染', () => {
  const partial = String.raw`结果 \[\lim_{x\to0}`;
  assert.equal(prepareAssistantMarkdown(partial), partial);
  assert.ok(render(partial, true).includes('结果'));
  const complete = partial + String.raw`x^2=0\]`;
  for (const streaming of [true, false]) {
    assert.match(render(complete, streaming), /class="katex-display"/);
    assert.doesNotMatch(render(complete, streaming), /katex-error/);
  }
  assert.match(render(String.raw`$a+b$` + '\n\n' + '日志'.repeat(30_000)), /class="katex"/, '大回复仅禁用代码高亮，不禁用公式');
});

test('非法公式可读地降级，回复内 HTML 或公式命令不能注入脚本、网络图片或链接', () => {
  const broken = render(String.raw`\[\frac{1}{\]`);
  assert.match(broken, /katex-error/);
  assert.ok(broken.includes('frac'));
  const untrusted = render(String.raw`\[\href{javascript:alert(1)}{click}\]

\[\includegraphics{https://example.test/image.png}\]

<script>alert(1)</script>`);
  assert.doesNotMatch(untrusted, /<script|<img|<a /);
});
