import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
function load(file,imports){
  const code=ts.transpileModule(readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context=vm.createContext({exports:{},require:name=>imports[name]??(()=>{throw new Error(name);})()});
  vm.runInContext(code,context);return context.exports;
}
const {isAgentContextStatus}=load('api/agentContext.ts',{});
const {AgentContextStatus}=load('components/AgentContextStatus.tsx',{'./Ui':{Icon:()=>null},'./AgentContextStatus.css':{},'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}});
const base={requestId:'r',usage:{inputTokens:1500,availableInputTokens:6000,contextWindow:8192,outputReserve:1680,safetyReserve:512,compactPercent:75,source:'estimated'},phase:'idle',method:null,errorCode:null,fallback:false,checkpointId:null,compactionCount:0,updatedAt:1};
function text(node){if(Array.isArray(node))return node.map(text).join('');if(node?.props)return text(node.props.children);return typeof node==='string'||typeof node==='number'?String(node):'';}
function nodes(node){if(Array.isArray(node))return node.flatMap(nodes);return node?.props?[node,...nodes(node.props.children)]:[];}
test('Unknown occupancy is not zero; measured input uses available budget and labels estimation separately',()=>{
  const unknown=AgentContextStatus({status:null});assert.match(text(unknown),/未测量/);assert.doesNotMatch(text(nodes(unknown).find(n=>n.type==='summary')),/0%/);assert.doesNotMatch(text(unknown),/已整理 0/);
  assert.equal(isAgentContextStatus(base),true);
  const tree=AgentContextStatus({status:base});assert.match(text(tree),/25%估算/);
  assert.match(text(tree),/不是累计 token 消耗/);
  assert.equal(nodes(tree).find(n=>n.props.role==='progressbar').props['aria-valuenow'],25);
  assert.match(text(AgentContextStatus({status:{...base,usage:{...base.usage,source:'providerCount'}}})),/供应商计数/);
});
test('Running, failed fallback and interruption never render compaction success or increment a counter',()=>{
  for(const phase of ['running','failed','cancelled','interrupted']){
    const state={...base,phase,method:'summary',fallback:phase==='failed'};
    assert.equal(isAgentContextStatus(state),true);
    const output=text(AgentContextStatus({status:state}));assert.doesNotMatch(output,/本次整理已保存/);assert.match(output,/已整理 0 次/);
  }
  assert.match(text(AgentContextStatus({status:{...base,phase:'failed',fallback:true}})),/已回退原上下文/);
  assert.match(text(AgentContextStatus({status:{...base,phase:'succeeded',checkpointId:'cp',compactionCount:1}})),/本次整理已保存/);
});
test('Malformed budgets, unknown sources and success without a real checkpoint are rejected',()=>{
  for(const bad of [{...base,phase:'succeeded'},{...base,usage:{...base.usage,availableInputTokens:0}},{...base,usage:{...base.usage,inputTokens:NaN}},{...base,usage:{...base.usage,source:'cumulative'}},{...base,usage:{...base.usage,safetyReserve:1}}])assert.equal(isAgentContextStatus(bad),false);
});
