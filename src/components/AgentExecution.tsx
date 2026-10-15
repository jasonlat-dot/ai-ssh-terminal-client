import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { agentApi, type ExecutionPolicy, type ExecutionReceipt, type OutputReference, type OutputRange } from '../api/agent';
import { Icon } from './Ui';
import { CopyTextButton } from './CopyTextButton';
import './AgentExecution.css';

const approvalModes=[
  {mode:'confirm',label:'请求批准',description:'需要授权的工具操作由你确认',icon:'user'},
  {mode:'auto',label:'帮我批准',description:'独立审查工具操作，风险或不明确时由你确认',icon:'shield'},
  {mode:'fullAccess',label:'完全访问权限',description:'当前任务的工具操作不再请求批准',icon:'alert'},
] as const;
const policyLabel=(policy:ExecutionPolicy|null)=>policy?.mode==='deny'?'已禁止执行':approvalModes.find(item=>item.mode===policy?.mode)?.label??'读取权限…';

export function ExecutionPolicyMenu({policy,disabled,error,retry,select}:{policy:ExecutionPolicy|null;disabled:boolean;error?:string;retry:()=>void;select:(mode:ExecutionPolicy['mode'])=>void}){
  const [open,setOpen]=useState(false);const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useEffect(()=>{
    if(!open)return;
    const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',close);
    return()=>document.removeEventListener('pointerdown',close);
  },[open]);
  return <div className={`execution-policy${open?' is-open':''}${policy?.mode==='fullAccess'?' is-full-access':''}`} ref={root}
    onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false);}}
    onKeyDown={event=>{
      if(event.key==='Escape'){setOpen(false);root.current?.querySelector<HTMLButtonElement>('.execution-policy-trigger')?.focus();event.stopPropagation();}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();setOpen(true);
        const items=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')??[]);
        const index=items.indexOf(document.activeElement as HTMLButtonElement);
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowUp'?(index<=0?items.length-1:index-1):(index+1)%items.length;
        requestAnimationFrame(()=>items[next]?.focus());
      }
    }}>
    <button type="button" className="execution-policy-trigger" aria-label="工具审核边界" aria-haspopup="menu" aria-expanded={open}
      disabled={disabled} onClick={()=>setOpen(value=>!value)} title="设置当前任务的工具审核边界"><Icon name={policy?.mode==='fullAccess'?'alert':'shield'} size={15}/><span>{policy?policyLabel(policy):error?'权限读取失败':'读取权限…'}</span><Icon name="down" size={11}/></button>
    <div className="execution-policy-menu" role="menu" aria-label="工具审核边界选项" inert={!open}>
      <p className="execution-policy-heading">如何批准工具操作？</p>
      {approvalModes.map(item=><button type="button" role="menuitemradio" aria-checked={policy?.mode===item.mode} key={item.mode} disabled={disabled||!policy}
        className={item.mode==='fullAccess'?'is-dangerous':''} onClick={()=>{setOpen(false);select(item.mode);}}>
        <Icon name={item.icon} size={17}/><span><strong>{item.label}</strong><small>{item.description}</small></span>{policy?.mode===item.mode&&<Icon name="check" size={16}/>}</button>)}
      <p className="execution-policy-footnote">适用于当前任务的工具操作 · 各工具仍受其访问边界约束</p>
    </div>
    {error&&<p className="execution-policy-error" role="alert">{error}<button type="button" onClick={retry}>重试</button></p>}
  </div>;
}

export type ExecutionScope={agentId:string;sessionId:string;enabled:boolean;available:boolean;connected:boolean;locked:boolean;hidden?:boolean;
  target?:{host:string;port:number;username:string;hostKey:string}|null;terminalId?:string;taskId?:string};
export const ExecutionContext=createContext<{agentId:string;sessionId:string}|null>(null);
const states:Record<ExecutionReceipt['state'],string>={pending:'等待确认',approved:'已批准，等待准入',denied:'已拒绝',cancelled:'已取消',expired:'已过期',admitted:'已准入，可能执行',completed:'执行已返回',notSent:'未发送',unknown:'结果未知，请先核查'};
export function approvalLabel(receipt:ExecutionReceipt,now=Date.now()){
  return (receipt.state==='pending'||receipt.state==='approved')&&receipt.expiresAt<=now?'已过期':states[receipt.state];
}
function commandExplanation(command:ExecutionReceipt['command']) {
  if(command.explanation?.trim())return command.explanation.trim();
  // Older receipts did not store a purpose. Only explain exact simple forms;
  // never infer the behavior of pipelines, substitutions or entire scripts.
  const text=command.command.trim();
  if(/^df\s+-h$/.test(text))return '查看各文件系统的磁盘总量、已用空间、可用空间和使用率，以易读的单位显示。';
  if(text==='whoami')return '查看当前终端实际执行命令的用户身份。';
  if(text==='pwd')return '显示当前终端所在的工作目录。';
  return '此命令未附用途说明，请结合上方完整命令确认操作。';
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
    <div className="execution-output-heading"><strong>{reference.channel==='stdout'?'完整结果':'诊断信息'}</strong><span>{reference.size.toLocaleString()} 字节</span>
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
  const resultText=[data.stdout,data.stderr].filter((value):value is string=>typeof value==='string'&&!!value).join('\n');
  return <div className="native-tool-output">
    <div className="execution-result-status"><Icon name={value.ok?'check':'alert'} size={13}/><span>{typeof data.exitCode==='number'?`退出码 ${data.exitCode}`:value.ok?'工具完成':'工具未完成'}{typeof value.error==='string'?` · ${value.error}`:''}</span></div>
    {data.outputTruncated===true&&<p className="execution-error">原始输出达到保存上限，仅保留已捕获部分。</p>}
    {data.outputError===true&&<p className="execution-error">输出存储不完整，请核查已有证据。</p>}
    {resultText&&<div className="execution-console"><div className="execution-console-heading"><span>执行结果</span><CopyTextButton getText={()=>resultText} label="复制执行结果" iconOnly/></div><pre tabIndex={0}>{resultText}</pre></div>}
    {outputs.some(reference=>reference.size>0)&&<details className="execution-output-details"><summary>查看完整输出<Icon name="down" size={12}/></summary>{outputs.filter(reference=>reference.size>0).map(reference=><OutputView reference={reference} key={reference.id}/>)}</details>}
    {!outputs.length&&typeof data.stdout!=='string'&&typeof data.stderr!=='string'&&<pre>{JSON.stringify(data,null,2)}</pre>}
  </div>;
}
export function ApprovalCard({receipt,disabled,act}:{receipt:ExecutionReceipt;disabled:boolean;act:(id:string,action:'approveOnce'|'approveTaskCommand'|'deny'|'cancel'|'revoke')=>void}){
  const [menuOpen,setMenuOpen]=useState(false);
  const pending=receipt.state==='pending'&&receipt.expiresAt>Date.now();
  const grant=receipt.grant;
  const content=<>
    <div className="execution-receipt-heading"><span><Icon name="terminal" size={16}/>SSH 终端</span><span className="execution-server" title="此处是 SSH 登录账号；工具使用绑定终端当前的 Shell 身份，包括已完成的 sudo 切换">{receipt.binding.identity.username}@{receipt.binding.identity.host}:{receipt.binding.identity.port}</span></div>
    {pending&&<h4>是否允许在此服务器执行以下命令？</h4>}
    {receipt.review&&<p className="execution-review-note"><Icon name="shield" size={13}/>{receipt.review.decision==='allow'?(receipt.review.mode==='fullAccess'?'完全访问权限 · ':'自动审查已批准 · '):'自动审查需要确认 · '}{receipt.review.reason}</p>}
    <div className="execution-command"><pre>{receipt.command.command}</pre><span className="execution-timeout">无输出超时 {receipt.command.timeoutSeconds} 秒</span><CopyTextButton getText={()=>receipt.command.command} label="复制命令" iconOnly/></div>
    <details className="execution-environment">
      <summary>执行环境与输出说明<Icon name="down" size={12}/></summary>
      <dl>
        <div><dt>命令用途</dt><dd>{commandExplanation(receipt.command)}</dd></div>
        <div><dt>执行环境</dt><dd>沿用当前终端的用户、目录和环境变量，包括已完成的 <code>sudo -i</code>。</dd></div>
        <div><dt>输出隔离</dt><dd>仅将本次命令单独捕获的输出交给模型。手工命令和后台终端输出不会作为工具结果。</dd></div>
        <div><dt>执行期间</dt><dd>暂停手工输入。批准前，请先退出交互程序，回到 Shell 提示符。</dd></div>
      </dl>
    </details>
    {pending&&<div className="execution-approval-footer">
      <button type="button" className="execution-cancel" disabled={disabled} onClick={()=>act(receipt.id,'cancel')}>取消请求</button>
      <div className="execution-approval-actions"><button type="button" className="execution-deny" disabled={disabled} onClick={()=>act(receipt.id,'deny')}>拒绝</button>
        <div className="execution-split-button"><button type="button" className="execution-approve" disabled={disabled} onClick={()=>act(receipt.id,'approveOnce')}>允许一次<Icon name="check" size={14}/></button>
          <div className={`execution-approval-menu${menuOpen?' is-open':''}`} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setMenuOpen(false);}} onKeyDown={event=>{if(event.key==='Escape'){setMenuOpen(false);event.stopPropagation();}}}>
            <button type="button" className="execution-menu-trigger" aria-label="更多批准选项" aria-expanded={menuOpen} disabled={disabled} onClick={()=>setMenuOpen(value=>!value)}><Icon name="down" size={14}/></button>
            <div className="execution-menu-options" inert={!menuOpen}><button type="button" disabled={disabled} onClick={()=>{setMenuOpen(false);act(receipt.id,'approveOnce');}}>允许一次<small>仅批准当前请求</small></button><button type="button" disabled={disabled} onClick={()=>{setMenuOpen(false);act(receipt.id,'approveTaskCommand');}}>本任务相同命令<small>有效 5 分钟，仅限此服务器与精确命令</small></button></div>
          </div>
        </div>
      </div>
    </div>}
    {receipt.state==='approved'&&<button type="button" disabled={disabled} onClick={()=>act(receipt.id,'cancel')}>撤回本次批准</button>}
    {grant&&<div className="execution-actions"><span>{grant.revoked?'相同命令授权已撤销':grant.expiresAt<=Date.now()?'相同命令授权已过期':`相同命令授权至 ${new Date(grant.expiresAt).toLocaleTimeString()}`}</span>
      {!grant.revoked&&grant.expiresAt>Date.now()&&<button type="button" disabled={disabled} onClick={()=>act(receipt.id,'revoke')}>撤销相同命令授权</button>}</div>}
    {(receipt.state==='unknown'||receipt.state==='admitted')&&<p className="execution-error">命令可能已经执行。停止生成不保证终止远端进程，请先核查，避免重复修改。</p>}
    {receipt.result!=null&&<NativeToolOutput output={JSON.stringify({ok:receipt.state==='completed',data:receipt.result})}/>}
  </>;
  return <article className={`execution-receipt is-${receipt.state}${pending?' needs-confirmation':''}`} aria-label={`命令${approvalLabel(receipt)}`}>
    {pending?content:<details className="execution-record"><summary><Icon name="terminal" size={14}/><span className="execution-record-state">{approvalLabel(receipt)}</span><code title={receipt.command.command}>{receipt.command.command}</code><Icon name="down" size={13} className="execution-chevron"/></summary><div className="execution-record-body">{content}</div></details>}
  </article>;
}
export function AgentExecution({scope,approvalTarget,policyTarget,onPendingChange}:{scope:ExecutionScope;approvalTarget?:HTMLElement|null;policyTarget?:HTMLElement|null;onPendingChange?:(pending:boolean)=>void}){
  const [receipts,setReceipts]=useState<ExecutionReceipt[]>([]);const [policy,setPolicy]=useState<ExecutionPolicy|null>(null);
  const [error,setError]=useState('');const [action,setAction]=useState('');const [expanded,setExpanded]=useState(false);const [more,setMore]=useState(false);
  const [reload,setReload]=useState(0);const alive=useRef(true);const loadedOlder=useRef(false);
  const [policyError,setPolicyError]=useState('');
  const policyScope=useRef('');
  const waiting=receipts.filter(receipt=>receipt.state==='pending'&&receipt.expiresAt>Date.now());
  // Auto-review runs before a human approval is requested. Do not replace the
  // composer with an approval card for a command the reviewer is still checking.
  const reviewing=policy?.mode==='auto'&&waiting.some(receipt=>!receipt.review);
  const pending=waiting.filter(receipt=>policy?.mode==='confirm'||(policy?.mode==='auto'&&receipt.review?.decision==='ask'));
  useEffect(()=>{onPendingChange?.(pending.length>0);return()=>onPendingChange?.(false);},[pending.length>0,onPendingChange]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(scope.hidden)return;
    let cancelled=false;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{const list=await agentApi.executionRequests(scope.agentId,scope.sessionId,'',controller.signal);
        if(cancelled)return;
        setReceipts(old=>[...list,...old.filter(item=>!list.some(current=>current.id===item.id))].slice(0,500));
        if(!loadedOlder.current)setMore(list.length===50);setError('');
        if(!approvalTarget&&list.some(r=>r.state==='pending'&&r.expiresAt>Date.now()))setExpanded(true);
      }catch(e){if(!cancelled)setError(e instanceof Error?e.message:'审批状态读取失败');}
      finally{if(!cancelled)timer=setTimeout(()=>void poll(),1000);}
    };
    void poll();return()=>{cancelled=true;controller.abort();clearTimeout(timer);};
  },[scope.agentId,scope.sessionId,scope.hidden,reload,approvalTarget]);
  useEffect(()=>{
    const key=JSON.stringify([scope.agentId,scope.sessionId,scope.taskId,scope.terminalId]);
    if(policyScope.current!==key){policyScope.current=key;setPolicy(null);}
    setPolicyError('');
    if(!scope.taskId&&!scope.terminalId)return;
    let cancelled=false;
    void agentApi.executionPolicy(scope.agentId,scope.sessionId)
      .then(value=>{if(!cancelled)setPolicy(value);})
      .catch(error=>{if(!cancelled)setPolicyError(error instanceof Error?error.message:'审核边界读取失败');});
    return()=>{cancelled=true;};
  },[scope.agentId,scope.sessionId,scope.taskId,scope.terminalId,reload]);
  const act=async(id:string,decision:'approveOnce'|'approveTaskCommand'|'deny'|'cancel'|'revoke')=>{
    if(action)return;setAction(id);setError('');
    try{await agentApi.executionDecision(scope.agentId,scope.sessionId,id,decision);if(alive.current&&decision==='revoke')setReceipts(old=>old.map(r=>r.id===id&&r.grant?{...r,grant:{...r.grant,revoked:true}}:r));}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:'操作失败，请刷新状态');}
    finally{if(alive.current){setAction('');setReload(v=>v+1);}}
  };
  const changePolicy=async(mode:ExecutionPolicy['mode'])=>{
    if(!policy||action||policy.mode===mode)return;setAction('policy');setPolicyError('');
    try{const p=await agentApi.setExecutionPolicy(scope.agentId,scope.sessionId,{mode,revision:policy.revision});if(alive.current)setPolicy(p);}
    catch(e){if(alive.current)setPolicyError(e instanceof Error?e.message:'审核边界更新失败');}
    finally{if(alive.current){setAction('');setReload(v=>v+1);}}
  };
  const loadMore=async()=>{
    if(action||!receipts.length)return;setAction('more');
    try{const list=await agentApi.executionRequests(scope.agentId,scope.sessionId,receipts[receipts.length-1].id);if(alive.current){loadedOlder.current=true;setReceipts(old=>[...old,...list.filter(item=>!old.some(r=>r.id===item.id))].slice(0,500));setMore(list.length===50);}}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:'读取失败');}
    finally{if(alive.current)setAction('');}
  };
  const policyMenu=<ExecutionPolicyMenu policy={policy} disabled={scope.locked||!!action||!scope.available||!policy} error={policyError} retry={()=>setReload(value=>value+1)} select={mode=>void changePolicy(mode)}/>;
  return <section className="agent-execution" aria-label="工具执行权限">
    <div className="execution-mode"><Icon name="shield" size={15}/><span>{scope.available?`工具权限 · ${policy?policyLabel(policy):policyError?'权限读取失败':'读取权限…'}`:'工具协议暂不支持'}</span>
      <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>审批与记录{receipts.some(r=>r.state==='pending')?' · 待确认':''}</button>
    </div>
    {scope.target&&<div className="execution-target">固定目标 {scope.target.username}@{scope.target.host}:{scope.target.port}{scope.connected?'':' · 已断开'}
      {scope.terminalId&&<details><summary>查看绑定身份</summary><span>终端 {scope.terminalId}</span><code>{scope.target.hostKey}</code></details>}</div>}
    {!scope.available&&<p>当前工具执行链支持 Chat Completions；Responses 工具调用尚未接入。</p>}
    {scope.available&&scope.target&&!scope.connected&&<p>重连此对话绑定的服务器后，SSH 工具将自动可用；当前仍可讨论历史记录。</p>}
    {reviewing&&<p className="execution-review-note" role="status"><Icon name="shield" size={13}/>正在独立审查工具操作…</p>}
    {expanded&&<div className="execution-history">
      <div className="execution-actions"><button type="button" disabled={!!action} onClick={()=>setReload(v=>v+1)}>刷新状态</button>
        {policy&&<button type="button" disabled={!!action} onClick={()=>void changePolicy(policy.mode==='deny'?'confirm':'deny')}>{policy.mode==='deny'?'恢复逐条确认':'禁止后续执行并撤销授权'}</button>}</div>
      {policy?.mode==='deny'&&<p>本任务已禁止执行；恢复后仍需逐条确认。</p>}
      {!receipts.length&&!error&&<p>暂无命令记录。模型提出的操作将按当前审核设置处理。</p>}
      {receipts.filter(receipt=>!approvalTarget||!pending.some(item=>item.id===receipt.id)).map(receipt=><ApprovalCard key={receipt.id} receipt={receipt} disabled={!!action} act={(id,decision)=>void act(id,decision)}/>)}
      {more&&receipts.length<500&&<button type="button" disabled={!!action} onClick={()=>void loadMore()}>加载更早记录</button>}
      {receipts.length>=500&&<p>已显示最近 500 条审批；各轮工具记录仍可从聊天历史查看。</p>}
    </div>}
    {error&&<p className="execution-error" role="alert">{error}<button type="button" onClick={()=>setReload(v=>v+1)}>重试</button></p>}
    {policyTarget&&createPortal(policyMenu,policyTarget)}
    {approvalTarget&&pending.length>0&&createPortal(<div className="composer-approval" aria-label="命令审批">{pending.length>1&&<p>有 {pending.length} 条命令等待确认</p>}<ApprovalCard key={pending[0].id} receipt={pending[0]} disabled={!!action} act={(id,decision)=>void act(id,decision)}/>{error&&<p className="execution-error" role="alert">{error}</p>}</div>,approvalTarget)}
  </section>;
}
