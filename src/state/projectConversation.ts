import type { AgentProject,ProjectChat } from '../api/agent';
import type { Host,TerminalSession } from '../types';
/** Restore the canonical session first; connection failure never replaces its history. */
export async function restoreProjectConversation(chat:ProjectChat,project:AgentProject|null,actions:{
 load:(sessionId:string,agentId:string)=>Promise<boolean|undefined>;
 selectProject:(project:AgentProject|null)=>void;
 connect:(project:AgentProject)=>Promise<unknown>;
 connectionFailed:(error:unknown)=>void;
}) {
 if(!(await actions.load(chat.sessionId,chat.agentId)))return false;
 actions.selectProject(project);
 if(project)try{await actions.connect(project);}catch(error){actions.connectionFailed(error);}
 return true;
}
/** A saved profile is only a preflight hint. Native binding verifies the actual SSH key. */
export async function ensureProjectTerminal(project:AgentProject,actions:{
 hosts:Host[]; find:()=>TerminalSession|undefined; verify:(session:TerminalSession)=>Promise<boolean|undefined>;
 open:(connectionId:string)=>Promise<TerminalSession|undefined>;
 bind:(projectId:string,terminalId:string)=>Promise<AgentProject>;
}) {
 const configured=actions.hosts.find(item=>item.id===project.connectionId);
 const expected=project.identity??project.profile;
 if(!configured)throw new Error('项目服务器已从保存列表删除，历史仍保留。');
 if(expected && (configured.address.replace(/^\[|\]$/g,'').toLowerCase()!==expected.host
  || (configured.port??22)!==expected.port || configured.user!==expected.username))
  throw new Error('已保存的服务器地址或账号与项目不同。请恢复原连接设置，或为新服务器新建项目；历史已保留。');
 let terminal=actions.find();
 if(terminal && !(await actions.verify(terminal)))terminal=undefined;
 terminal??=await actions.open(project.connectionId);
 if(!terminal)throw new Error('服务器未连接，历史已保留。请检查连接设置后重试。');
 const verified=await actions.bind(project.id,terminal.terminalSessionId);
 return {terminal,project:verified};
}
