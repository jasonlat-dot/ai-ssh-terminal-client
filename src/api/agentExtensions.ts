import { builtinRequest } from './builtin';
import { sshUserId } from './ssh';
export type McpTokenChange = {action:'keep'|'clear'} | {action:'set';value:string};
export type McpServer = {name:string;enabled:boolean;description?:string;bearerToken?:McpTokenChange;bearerTokenConfigured?:boolean;connectionValues?:{headers:Record<string,string>;env:Record<string,string>};savedHeaders?:string[];savedEnv?:string[]} & ({transport:'stdio';command:string;args:string[];env:string[]}|{transport:'streamableHttp';url:string;bearerEnv:string}|{transport:'sse';url:string;bearerEnv:string;timeoutSeconds:number});
export type ExecutionLimits={modelRounds:number;toolCalls:number;childModelRounds:number;childToolCalls:number;maxChildTasks:number};
export const defaultExecutionLimits:ExecutionLimits={modelRounds:32,toolCalls:128,childModelRounds:24,childToolCalls:64,maxChildTasks:6};
export type ExtensionSettings={revision:number;config:{servers:McpServer[];skillRoots:string[];subAgents:boolean;executionLimits:ExecutionLimits}};
export type ExtensionSaveScope='execution'|'mcp'|'skills';
export type ExtensionReceipt={id:string;sessionId:string;callId:string;toolName:string;arguments:Record<string,unknown>;destination:string;task:{goal:string;target?:{connectionId:string;terminalSessionId:string}};state:string;review?:{decision:string;reason:string};expiresAt:number};
export const extensionApi={
  settings:()=>builtinRequest<ExtensionSettings>('agent/extensions_settings','GET',null,{userId:sshUserId}),
  save:(settings:ExtensionSettings,scope:ExtensionSaveScope)=>builtinRequest<ExtensionSettings>('agent/extensions_settings','POST',{userId:sshUserId,...settings,scope},{}),
  requests:(agentId:string,sessionId:string,signal?:AbortSignal)=>builtinRequest<ExtensionReceipt[]>('agent/extensions_requests','GET',null,{agentId,sessionId,userId:sshUserId},signal),
  decide:(agentId:string,sessionId:string,id:string,allow:boolean)=>builtinRequest<boolean>('agent/extensions_decision','POST',{agentId,sessionId,userId:sshUserId,id,allow},{}),
};
