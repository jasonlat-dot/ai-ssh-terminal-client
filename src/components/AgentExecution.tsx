import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { agentApi, type ExecutionPolicy, type ExecutionReceipt, type OutputReference, type OutputRange } from '../api/agent';
import { Icon } from './Ui';
import './AgentExecution.css';

export type ExecutionScope={agentId:string;sessionId:string;enabled:boolean;available:boolean;connected:boolean;locked:boolean;hidden?:boolean;
  target?:{host:string;port:number;username:string;hostKey:string}|null;terminalId?:string;toggle:()=>Promise<void>};
export const ExecutionContext=createContext<{agentId:string;sessionId:string}|null>(null);
const states:Record<ExecutionReceipt['state'],string>={pending:'等待确认',approved:'已批准，等待准入',denied:'已拒绝',cancelled:'已取消',expired:'已过期',admitted:'已准入，可能执行',completed:'执行已返回',notSent:'未发送',unknown:'结果未知，请先核查'};
export function approvalLabel(receipt:ExecutionReceipt,now=Date.now()){
  return (receipt.state==='pending'||receipt.state==='approved')&&receipt.expiresAt<=now?'已过期':states[receipt.state];
}
export function outputReferences(value:unknown):OutputReference[]{
  if(!value||typeof value!=='object')return [];
  const refs=(value as {outputs?:unknown}).outputs;
  return Array.isArray(refs)?refs.filter((r):r is OutputReference=>!!r&&typeof r.id==='string'&&['stdout','stderr'].includes(r.channel)&&Number.isSafeInteger(r.size)&&r.size>=0&&typeof r.sha256==='string'):[];
}
export function decodeOutput(range:OutputRange){
  const bytes=new Uint8Array(range.bytes);
  let lossy=false;let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{lossy=true;text=new TextDecoder().decode(bytes);}
  return {text,lossy,hex:Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(' ')};
}
function OutputView({reference}:{reference:OutputReference}){
  const scope=useContext(ExecutionContext);
  const [range,setRange]=useState<OutputRange|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [hex,setHex]=useState(false);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const load=async(offset:number)=>{
    if(!scope||busy)return;setBusy(true);setError('');
    try{const data=await agentApi.executionOutput(scope.agentId,scope.sessionId,reference.id,offset);if(mounted.current)setRange(data);}
    catch(e){if(mounted.current)setError(e instanceof Error?e.message:'读取失败');}
    finally{if(mounted.current)setBusy(false);}
  };
  const decoded=range?decodeOutput(range):null;
  return <div className="execution-output">
    <div className="execution-output-heading"><strong>{reference.channel}</strong><span>{reference.size.toLocaleString()} 字节</span>
      <button type="button" disabled={!scope||busy} onClick={()=>void load(0)}>{busy?'读取中…':range?'回到开头':'读取原始输出'}</button></div>
    {range&&decoded&&<><div className="execution-output-toolbar"><span>字节 {range.offset}–{range.nextOffset} / {range.size}{range.eof?' · 已到末尾':''}</span>
      <button type="button" onClick={()=>setHex(v=>!v)}>{hex?'显示文本':'十六进制'}</button></div>
      <pre tabIndex={0}>{hex?decoded.hex:decoded.text||'（空输出）'}</pre>
      {decoded.lossy&&!hex&&<p>本段包含非 UTF-8 字节或跨段字符，可切换十六进制查看原始数据。</p>}
      <div className="execution-actions"><button type="button" disabled={busy||range.offset===0} onClick={()=>void load(Math.max(0,range.offset-4096))}>上一段</button>
      <button type="button" disabled={busy||range.eof} onClick={()=>void load(range.nextOffset)}>下一段</button></div></>}
    {error&&<p className="execution-error" role="alert">{error}<button type="button" disabled={busy} onClick={()=>void load(range?.offset??0)}>重试读取</button></p>}
  </div>;
}
export function NativeToolOutput({output}:{output:string}){
  let value:Record<string,unknown>;
  try{value=JSON.parse(output);}catch{return <pre>{output}</pre>;}
  if(!value||typeof value!=='object'||typeof value.ok!=='boolean')return <pre>{output}</pre>;
  const data=value.data as Record<string,unknown>|undefined;
  if(!data||typeof data!=='object')return <pre>{output}</pre>;
  const outputs=outputReferences(data);
  return <div className="native-tool-output">
    <p>{typeof data.exitCode==='number'?`退出码 ${data.exitCode}`:value.ok?'工具完成':'工具未完成'}{typeof value.error==='string'?` · ${value.error}`:''}</p>
    {data.outputTruncated===true&&<p className="execution-error">原始输出达到保存上限，仅保留已捕获部分。</p>}
    {data.outputError===true&&<p className="execution-error">输出存储不完整，请核查已有证据。</p>}
    {(['stdout','stderr'] as const).map(channel=>typeof data[channel]==='string'&&data[channel]?<div key={channel}><small>{channel} · 有界预览</small><pre>{data[channel]}</pre></div>:null)}
    {outputs.map(reference=><OutputView reference={reference} key={reference.id}/>)}
    {!outputs.length&&typeof data.stdout!=='string'&&typeof data.stderr!=='string'&&<pre>{JSON.stringify(data,null,2)}</pre>}
  </div>;
}
export function ApprovalCard({receipt,disabled,act}:{receipt:ExecutionReceipt;disabled:boolean;act:(id:string,action:'approveOnce'|'approveTaskCommand'|'deny'|'cancel'|'revoke')=>void}){
  const pending=receipt.state==='pending'&&receipt.expiresAt>Date.now();
  const grant=receipt.grant;
  return <article className={`execution-receipt is-${receipt.state}`} aria-label={`命令${approvalLabel(receipt)}`}>
    <div className="execution-receipt-heading"><strong>{approvalLabel(receipt)}</strong><span>{receipt.binding.identity.username}@{receipt.binding.identity.host}:{receipt.binding.identity.port}</span></div>
    <pre tabIndex={0}>{receipt.command.command}</pre>
    <p>超时 {receipt.command.timeoutSeconds} 秒 · 输出显示在对话中 · 独立命令环境，不继承终端当前目录</p>
    {pending&&<><p>请核对服务器与命令。确认仅针对上面显示的内容。</p><div className="execution-actions">
      <button type="button" className="execution-approve" disabled={disabled} onClick={()=>act(receipt.id,'approveOnce')}>仅允许这次</button>
      <button type="button" disabled={disabled} onClick={()=>act(receipt.id,'approveTaskCommand')}>本任务相同命令 · 5 分钟</button>
      <button type="button" disabled={disabled} onClick={()=>act(receipt.id,'deny')}>拒绝</button>
      <button type="button" disabled={disabled} onClick={()=>act(receipt.id,'cancel')}>取消请求</button>
    </div></>}
    {receipt.state==='approved'&&<button type="button" disabled={disabled} onClick={()=>act(receipt.id,'cancel')}>撤回本次批准</button>}
    {grant&&<div className="execution-actions"><span>{grant.revoked?'相同命令授权已撤销':grant.expiresAt<=Date.now()?'相同命令授权已过期':`相同命令授权至 ${new Date(grant.expiresAt).toLocaleTimeString()}`}</span>
      {!grant.revoked&&grant.expiresAt>Date.now()&&<button type="button" disabled={disabled} onClick={()=>act(receipt.id,'revoke')}>撤销相同命令授权</button>}</div>}
    {(receipt.state==='unknown'||receipt.state==='admitted')&&<p className="execution-error">命令可能已经执行。停止生成不保证终止远端进程，请先核查，避免重复修改。</p>}
    {receipt.result!=null&&<NativeToolOutput output={JSON.stringify({ok:true,data:receipt.result})}/>}
  </article>;
}
export function AgentExecution({scope}:{scope:ExecutionScope}){
  const [receipts,setReceipts]=useState<ExecutionReceipt[]>([]);const [policy,setPolicy]=useState<ExecutionPolicy|null>(null);
  const [error,setError]=useState('');const [action,setAction]=useState('');const [expanded,setExpanded]=useState(false);const [more,setMore]=useState(false);
  const [reload,setReload]=useState(0);const alive=useRef(true);const loadedOlder=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(scope.hidden)return;
    let cancelled=false;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{const list=await agentApi.executionRequests(scope.agentId,scope.sessionId,'',controller.signal);
        if(cancelled)return;
        setReceipts(old=>[...list,...old.filter(item=>!list.some(current=>current.id===item.id))].slice(0,500));
        if(!loadedOlder.current)setMore(list.length===50);setError('');
        if(list.some(r=>r.state==='pending'&&r.expiresAt>Date.now()))setExpanded(true);
      }catch(e){if(!cancelled)setError(e instanceof Error?e.message:'审批状态读取失败');}
      finally{if(!cancelled)timer=setTimeout(()=>void poll(),1000);}
    };
    void poll();return()=>{cancelled=true;controller.abort();clearTimeout(timer);};
  },[scope.agentId,scope.sessionId,scope.hidden,reload]);
  useEffect(()=>{if(!scope.terminalId)return;let cancelled=false;void agentApi.executionPolicy(scope.agentId,scope.sessionId).then(p=>{if(!cancelled)setPolicy(p);}).catch(()=>{if(!cancelled)setPolicy(null);});return()=>{cancelled=true;};},[scope.agentId,scope.sessionId,scope.terminalId,reload]);
  const act=async(id:string,decision:'approveOnce'|'approveTaskCommand'|'deny'|'cancel'|'revoke')=>{
    if(action)return;setAction(id);setError('');
    try{await agentApi.executionDecision(scope.agentId,scope.sessionId,id,decision);if(alive.current&&decision==='revoke')setReceipts(old=>old.map(r=>r.id===id&&r.grant?{...r,grant:{...r.grant,revoked:true}}:r));}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:'操作失败，请刷新状态');}
    finally{if(alive.current){setAction('');setReload(v=>v+1);}}
  };
  const changePolicy=async()=>{
    if(!policy||action)return;setAction('policy');
    try{const p=await agentApi.setExecutionPolicy(scope.agentId,scope.sessionId,{mode:policy.mode==='deny'?'confirm':'deny',revision:policy.revision});if(alive.current)setPolicy(p);}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:'策略更新失败');}
    finally{if(alive.current){setAction('');setReload(v=>v+1);}}
  };
  const loadMore=async()=>{
    if(action||!receipts.length)return;setAction('more');
    try{const list=await agentApi.executionRequests(scope.agentId,scope.sessionId,receipts[receipts.length-1].id);if(alive.current){loadedOlder.current=true;setReceipts(old=>[...old,...list.filter(item=>!old.some(r=>r.id===item.id))].slice(0,500));setMore(list.length===50);}}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:'读取失败');}
    finally{if(alive.current)setAction('');}
  };
  return <section className="agent-execution" aria-label="服务器执行权限">
    <div className="execution-mode"><Icon name="shield" size={15}/><span>{scope.enabled?'SSH 工具 · 逐条确认':'文字对话'}</span>
      <button type="button" disabled={scope.locked||!!action||(!scope.enabled&&(!scope.connected||!scope.available))} onClick={()=>void scope.toggle()}>{scope.enabled?'切换文字对话':'启用 SSH 工具'}</button>
      <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>审批与记录{receipts.some(r=>r.state==='pending')?' · 待确认':''}</button>
    </div>
    {scope.target&&<p className="execution-target">固定目标 {scope.target.username}@{scope.target.host}:{scope.target.port}{scope.connected?'':' · 已断开'}
      {scope.terminalId&&<details><summary>查看绑定身份</summary><span>终端 {scope.terminalId}</span><code>{scope.target.hostKey}</code></details>}</p>}
    {!scope.available&&<p>此模型尚未启用函数工具；可在模型设置中开启 Chat Completions 工具能力。</p>}
    {expanded&&<div className="execution-history">
      <div className="execution-actions"><button type="button" disabled={!!action} onClick={()=>setReload(v=>v+1)}>刷新状态</button>
        {policy&&<button type="button" disabled={!!action} onClick={()=>void changePolicy()}>{policy.mode==='deny'?'恢复逐条确认':'禁止后续执行并撤销授权'}</button>}</div>
      {policy?.mode==='deny'&&<p>本任务已禁止执行；恢复后仍需逐条确认。</p>}
      {!receipts.length&&!error&&<p>暂无命令记录。启用后，模型提出的命令会在此等待确认。</p>}
      {receipts.map(receipt=><ApprovalCard key={receipt.id} receipt={receipt} disabled={!!action} act={(id,decision)=>void act(id,decision)}/>)}
      {more&&receipts.length<500&&<button type="button" disabled={!!action} onClick={()=>void loadMore()}>加载更早记录</button>}
      {receipts.length>=500&&<p>已显示最近 500 条审批；各轮工具记录仍可从聊天历史查看。</p>}
    </div>}
    {error&&<p className="execution-error" role="alert">{error}<button type="button" onClick={()=>setReload(v=>v+1)}>重试</button></p>}
  </section>;
}
