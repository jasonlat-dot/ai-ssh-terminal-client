import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { toolToMarkdown } from '../src/state/chatMarkdown.ts';
import { activitySummary, isVisibleToolActivity } from '../src/state/agentTranscript.ts';

// Render the actual tool/transcript/child components; force the child disclosure
// open to check the nested path as well as the normal top-level path.
const source = ts.createSourceFile('AgentPanel.tsx', readFileSync(new URL('../src/components/AgentPanel.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['ToolActivity', 'ActivityTranscript', 'AgentActivity', 'AgentTextActivity', 'ReplyLoading']);
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(source));
const compiled = ts.transpileModule(`${functions.join('\n')}\nexports.components={ToolActivity,ActivityTranscript,AgentActivity,ReplyLoading};`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
let expandedOverride = true;
const context = vm.createContext({ exports: {}, require: () => jsx, activitySummary, isVisibleToolActivity, toolToMarkdown,
  Icon: () => null, AccentIcon: () => null, Badge: () => null, CopyTextButton: () => null, CopyMarkdownButton: () => null,
  NativeToolOutput: ({output}) => React.createElement('pre', null, output), MarkdownMessage: ({children}) => React.createElement('p', null, children),
  useState: initial => [initial === false ? expandedOverride : typeof initial === 'function' ? initial() : initial, value => {expandedOverride=value;}], useEffect() {},
});
vm.runInContext(compiled, context);
const { ToolActivity, ActivityTranscript, AgentActivity, ReplyLoading } = context.exports.components;
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const read = (id, status = 'success') => ({ id, name: 'read_tool_output', status, output: `read evidence ${id}` });
const command = { id: 'cmd', name: 'ssh_execute', status: 'success', command: 'df -h', output: 'disk result' };
const activities = tools => tools.map(tool => ({ id: tool.id, type: 'tool', tool }));

test('Main transcript hides normal reads and their count, while keeping the actual command', () => {
  const html = render(ActivityTranscript, { activities: activities([command, read('one'), read('two', 'running')]), copyable: true });
  assert.match(html, /运行了 1 条命令/); assert.match(html, /df -h/); assert.match(html, /disk result/);
  assert.doesNotMatch(html, /回查|read evidence|读取工具输出|进行中/);
  assert.equal(render(ActivityTranscript, { activities: activities([read('one')]), copyable: true }), '');
});
test('Failed or uncertain reads show an explicit warning and retain their diagnostic detail', () => {
  for (const status of ['error', 'unknown']) {
    const html = render(ActivityTranscript, { activities: activities([read('problem', status)]), copyable: true });
    assert.match(html, /输出读取异常/); assert.match(html, /分析结果可能不完整/); assert.match(html, /read evidence problem/);
    assert.match(html, status === 'error' ? /读取失败/ : /读取状态未知/);
  }
  assert.equal(render(ToolActivity, { tool: read('ok'), copyable: true }), '');
});
test('Expanded child transcripts hide normal output reads in both segments and legacy tools', () => {
  const tools = [command, read('hidden'), read('failed', 'error')];
  for (const segments of [undefined, activities(tools)]) {
    const html = render(AgentActivity, { agent: { id: 'child', name: 'child', status: 'success', tools, segments }, copyable: true });
    assert.match(html, /df -h/); assert.doesNotMatch(html, /read evidence hidden/);
    assert.match(html, /read evidence failed/); assert.match(html, /分析结果可能不完整/);
  }
});
test('Background output paging is not presented as an executing command in the loading status', () => {
  const tool = read('running', 'running');
  const html = render(ReplyLoading, { message: { text: '正在分析', tools: [tool], segments: activities([tool]) }, stopping: false });
  assert.doesNotMatch(html, /正在执行工具/); assert.match(html, /正在生成回复/);
});


test('工具展开直接激活原始输出，复制按钮使用解析后的完整文本且读取期间禁用',()=>{
  const find=(node,predicate)=>{
    if(Array.isArray(node)){for(const child of node){const result=find(child,predicate);if(result)return result;}return;}
    if(!node?.props)return;
    return predicate(node)?node:find(node.props.children,predicate);
  };
  const props={tool:{...command,output:JSON.stringify({ok:true,data:{stdout:'preview'}})},copyable:true};
  expandedOverride=false;
  let tree=ToolActivity(props);
  let output=find(tree,node=>typeof node.props.renderActions==='function');
  assert.equal(output.props.active,false);
  const target={open:true};tree.props.onToggle({target,currentTarget:target});
  tree=ToolActivity(props);output=find(tree,node=>typeof node.props.renderActions==='function');
  assert.equal(output.props.active,true);
  for(const ready of [false,true]){
    const actions=output.props.renderActions(()=> 'full shell result\n',ready);
    const copy=find(actions,node=>node.props.label==='复制输出');
    assert.equal(copy.props.disabled,!ready);assert.equal(copy.props.getText(),'full shell result\n');
    const markdown=find(actions,node=>node.props.label==='复制工具结果（Markdown）');
    assert.equal(markdown.props.disabled,!ready);assert.match(markdown.props.getText(),/full shell result/);
    assert.doesNotMatch(markdown.props.getText(),/preview|"ok"/);
  }
  // A nested disclosure event must not overwrite the command's own open state.
  tree.props.onToggle({target:{open:false},currentTarget:{open:false}});
  assert.equal(find(ToolActivity(props),node=>typeof node.props.renderActions==='function').props.active,true);
});
