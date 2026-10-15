// Local UI fixture: no backend, SSH connection, credentials or actual permission changes.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentPanel} from '../../src/components/AgentPanel';
import {agentApi, type ExecutionPolicy} from '../../src/api/agent';
import {AttachmentPreviews,ChatAttachmentDraft} from '../../src/state/chatAttachments';
import type {ChatMessage} from '../../src/types';
import '../../src/App.css';
import '../../src/reference.css';
import '../../src/typography.css';
import '../../src/components/AgentDesktopLayout.css';
import '../../src/components/AgentComposer.css';
import '../../src/components/AgentTranscript.css';

let policy:ExecutionPolicy={mode:'confirm',revision:0};
agentApi.executionRequests=async()=>[];
agentApi.executionPolicy=async()=>({...policy});
agentApi.setExecutionPolicy=async(_agent,_session,next)=>{policy={mode:next.mode,revision:policy.revision+1};return {...policy};};
const output=Array.from({length:40},(_,i)=>'Layer '+String(i+1).padStart(2,'0')+': download complete').join('\n');
const messages:ChatMessage[]=[
  {id:'u1',role:'user',text:'检查服务器状态，展示命令详情。'},
  {id:'a1',role:'assistant',text:'查询结果如下。',tools:[
    {id:'cmd1',name:'ssh_execute',command:'docker ps -a',status:'success',output:JSON.stringify({ok:true,data:{exitCode:0,stdout:output,stderr:''}})},
    {id:'cmd2',name:'ssh_execute',command:'df -h',status:'success',output:JSON.stringify({ok:true,data:{exitCode:0,stdout:'Filesystem Size Used Avail Use%\n/dev/sda 100G 20G 80G 20%',stderr:''}})},
  ]},
  ...Array.from({length:8},(_,i):ChatMessage=>({id:'msg'+i,role:i%2?'assistant':'user',text:i%2?'这是后续回复，用于验证执行过程到达边界后继续滚动外层聊天记录。':'继续查看第 '+(i+1)+' 条消息。'})),
];
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><main style={{display:'flex',flexDirection:'column',height:'100dvh',maxWidth:1050,margin:'0 auto',padding:20,boxSizing:'border-box'}}>
    <AgentPanel chatDraft={new ChatAttachmentDraft(new AttachmentPreviews())} draftScope={1}
      connected localTerminal={false} messages={messages} busy={false} stopping={false} disabled={false} collapsed={false}
      targetLabel="本地测试 · 无真实 SSH 连接"
      agentAvailability={{ready:true,loading:false,error:'',retry(){}}}
      history={{external:true,sessions:[],activeSessionId:'test',open:false,loading:false,loadingSessionId:'',error:'',toggle(){},refresh(){},select(){}}}
      models={[{agentId:'model',agentName:'测试模型'}]} selectedModel="model" send={async()=>true} stop={()=>{}} clear={()=>{}}
      execution={{agentId:'model',sessionId:'test',enabled:true,available:true,connected:true,locked:false,terminalId:'mock-terminal',target:{host:'test.invalid',port:22,username:'tester',hostKey:'mock'}}}
    />
  </main></React.StrictMode>,
);
