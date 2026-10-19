import type { ChatMessageSegment, ChatToolActivity } from '../types';

export type ActivitySegment = Exclude<ChatMessageSegment, {type:'text'}>;
export type TranscriptBlock = Extract<ChatMessageSegment,{type:'text'}> | {id:string;type:'activities';activities:ActivitySegment[]};

/** Output paging stays in the evidence; only failed or uncertain reads need UI. */
export function isVisibleToolActivity(tool:ChatToolActivity):boolean {
  return tool.name!=='read_tool_output'||tool.status==='error'||tool.status==='unknown';
}

/** Adjacent activity records share a disclosure; intervening prose stays in its original position. */
export function transcriptBlocks(segments:readonly ChatMessageSegment[]):TranscriptBlock[] {
  const blocks:TranscriptBlock[]=[];
  for(const segment of segments){
    if(segment.type==='tool'&&!isVisibleToolActivity(segment.tool))continue;
    if(segment.type==='text') {if(segment.text.trim())blocks.push(segment);continue;}
    const last=blocks[blocks.length-1];
    if(last?.type==='activities')last.activities.push(segment);
    else blocks.push({id:segment.id,type:'activities',activities:[segment]});
  }
  return blocks;
}

export function activitySummary(activities:readonly ActivitySegment[]):string {
  let commands=0,readIssues=0,tools=0,agents=0,running=0,errors=0,unknown=0;
  for(const item of activities){
    if(item.type==='tool'&&!isVisibleToolActivity(item.tool))continue;
    const state=item.type==='tool'?item.tool.status:item.agent.status;
    if(state==='running')running++;if(state==='error')errors++;if(state==='unknown')unknown++;
    if(item.type==='agent')agents++;
    else if(item.tool.name==='ssh_execute'||item.tool.name==='executeCommand')commands++;
    else if(item.tool.name==='read_tool_output')readIssues++;
    else tools++;
  }
  const labels=[commands?`${running?'运行':'运行了'} ${commands} 条命令`:'',readIssues?`${readIssues} 项输出读取异常`:'',tools?`调用了 ${tools} 次工具`:'',agents?`调用了 ${agents} 个智能体`:''].filter(Boolean);
  return labels.join('，')+(running?` · ${running} 项进行中`:'')+(errors?` · ${errors} 项失败`:'')+(unknown?` · ${unknown} 项结果未知`:'');
}
