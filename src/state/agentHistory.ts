import type { AgentHistory, AgentTurn } from '../api/agent';
import type { ChatMessage, ChatMessageSegment, ChatToolActivity } from '../types';

function toolSegments(turn:AgentTurn):ChatMessageSegment[]|undefined {
  if(!turn.toolEvents?.length)return undefined;
  const tools=new Map<string,ChatToolActivity>();
  const parents=new Map<string,string>();const tasks=new Map<string,string>();
  for(const event of turn.toolEvents){const p=event.payload;
    if(p.type==='toolCall'){
      let args=p.arguments.modelArguments??p.arguments;
      if(typeof args==='string'){try{args=JSON.parse(args);}catch{args={};}}
      if(typeof p.arguments.parentToolCallId==='string')parents.set(p.callId,p.arguments.parentToolCallId);
      if(p.toolName==='delegate_agent'&&args&&typeof args==='object'&&'task' in args&&typeof args.task==='string')tasks.set(p.callId,args.task);
      const command=args&&typeof args==='object'&&'command' in args&&typeof args.command==='string'?args.command:undefined;
      tools.set(p.callId,{id:p.callId,name:p.toolName,command,status:turn.state==='running'?'running':'unknown'});
    }else{const old=tools.get(p.callId);let output=p.text;
      if(p.outputs?.length){try{const parsed=JSON.parse(output);if(parsed&&typeof parsed==='object')output=JSON.stringify({...parsed,data:{...parsed.data,outputs:p.outputs}});}catch{/* Preserve original evidence text. */}}
      tools.set(p.callId,{id:p.callId,name:old?.name??'工具',command:old?.command,status:p.outcome==='success'?'success':p.outcome==='unknown'?'unknown':'error',output});}
  }
  const visible=(tool:ChatToolActivity)=>turn.state!=='running'||!!tool.output||turn.startedToolCallIds?.includes(tool.id)===true;
  const segments:ChatMessageSegment[]=[...tools.values()].filter(tool=>!parents.has(tool.id)&&visible(tool)).map(tool=>{
    if(tool.name!=='delegate_agent')return {id:tool.id,type:'tool',tool};
    let output=tool.output;try{const data=JSON.parse(output??'{}').data;if(typeof data?.report==='string')output=data.report;}catch{/* Keep original failure evidence. */}
    const children=[...tools.values()].filter(child=>parents.get(child.id)===tool.id&&visible(child));
    return {id:tool.id,type:'agent',agent:{id:tool.id,name:'子任务',task:tasks.get(tool.id),status:tool.status,output,tools:children,segments:children.map(child=>({id:child.id,type:'tool',tool:child}))}};
  });
  const text=turn.state==='completed'?turn.resultText:turn.partialText;
  if(text)segments.push({id:`${turn.requestId}:text`,type:'text',text});
  return segments;
}
const states = { running: '仍在生成，可刷新历史或停止。', completed: '', cancelled: '已停止生成。', failed: '生成失败。', interrupted: '生成已中断，重新发送会开始新的请求。' };
export function turnMessages(turns: AgentTurn[]): ChatMessage[] {
  return turns.flatMap(turn => [
    { id: `${turn.requestId}:user`, role: 'user' as const, text: turn.message, attachments:turn.attachments?.map(file=>({...file})), timestamp: turn.createdAt },
    ...(turn.inputs??[]).map(input=>({id:input.id,role:'user' as const,text:input.message,timestamp:input.createdAt,inputPending:input.eventId===null})),
    { id: turn.requestId, role: 'assistant' as const, timestamp: turn.state === 'running' ? undefined : turn.updatedAt,
      text: turn.state === 'completed' ? turn.resultText ?? '' : turn.partialText,
      summary: states[turn.state] || undefined,
      segments: toolSegments(turn),
      error: turn.state === 'failed' || turn.state === 'interrupted',
      errorCode: turn.errorCode ?? undefined,
      errorMessage: turn.errorMessage ?? undefined },
  ]);
}
/** Bounded full history, never silently show the first page as the entire session. */
export async function readAgentHistory(read: (after: number) => Promise<AgentHistory>): Promise<AgentHistory> {
  let after = 0;
  let revision: number | undefined;
  const turns: AgentTurn[] = [];
  for (let page = 0; page < 20; page++) {
    const history = await read(after);
    if (revision !== undefined && history.session.revision !== revision) throw new Error('加载期间会话已更新，请刷新历史。');
    revision = history.session.revision;
    turns.push(...history.turns);
    if (!history.hasMore) return { ...history, turns };
    if (history.nextAfter <= after) throw new Error('历史分页游标未前进，请刷新重试。');
    after = history.nextAfter;
  }
  throw new Error('历史会话过长，未完整加载。');
}
