import {sftpApi} from '../api/sftp';
import {directoryChild} from './terminalDirectory';
import type {TerminalRuntime} from './terminalRuntime';

export type SidebarFileOperation = {kind:'rename'|'move'|'delete'; names:string[]; path:string; value:string};

export function fileSelection(current:string[], names:string[], name:string, anchor:string,
  modifiers:{ctrlKey?:boolean;metaKey?:boolean;shiftKey?:boolean} = {}):string[] {
  if (modifiers.shiftKey && names.includes(anchor)) {
    const from=names.indexOf(anchor), to=names.indexOf(name);
    if(to<0)return current;
    const range=names.slice(Math.min(from,to),Math.max(from,to)+1);
    return modifiers.ctrlKey||modifiers.metaKey?[...new Set([...current,...range])]:range;
  }
  return modifiers.ctrlKey||modifiers.metaKey
    ?current.includes(name)?current.filter(item=>item!==name):[...current,name]:[name];
}

export function fileOperationJobs(operation:SidebarFileOperation) {
  const {kind,path,value}=operation, names=[...new Set(operation.names)];
  const destination=kind==='move'?(value.replace(/\/+/g,'/').replace(/\/$/,'')||'/'):value;
  const validName=(name:string)=>!!name&&!['.','..'].includes(name)&&!/[\x00-\x1f\x7f-\x9f/\\*?]/u.test(name)&&new TextEncoder().encode(name).length<=255;
  const validPath=(path:string)=>path.startsWith('/')&&new TextEncoder().encode(path).length<=4096
    &&(path==='/'||path.split('/').slice(1).every(validName));
  if(!validPath(path)||!names.length||names.some(name=>!validName(name)))throw new Error('文件名或目录路径无效，请刷新后重试。');
  if(kind==='rename'&&(names.length!==1||!validName(value)))throw new Error('请输入有效的新名称，不能包含斜杠、通配符或控制字符。');
  if(kind==='move'&&(!value||!validPath(destination)))throw new Error('请输入已存在的目标目录绝对路径。');
  return names.map(name=>{
    const from=directoryChild(path,name), to=kind==='rename'?directoryChild(path,value):kind==='move'?directoryChild(destination,name):undefined;
    if(to&&(from===to||to.startsWith(`${from}/`)))throw new Error('不能移动到原路径或目录自身的子目录。');
    return {from,to,name};
  });
}

/** Temporary metadata session is bound to this terminal's existing identity.
 * It never replaces the persistent transfer controller or asks for a password. */
export async function runSidebarFileOperation(runtime:TerminalRuntime, operation:SidebarFileOperation, valid:()=>boolean) {
  const jobs=fileOperationJobs(operation);
  const check=()=>{if(!valid()||runtime.closed||runtime.disconnected||runtime.manuallyClosed||runtime.transportAvailable===false)throw new Error('终端、目录或访问身份已变化，请重新选择。');};
  check();
  const session=await sftpApi.open(runtime.connectionId,'/',()=>{},'login',undefined,runtime.sessionId);
  let completed=0;
  try {
    check();
    for(const job of jobs){
      try{
        check();
        if(operation.kind==='delete')await sftpApi.deleteEntry(session.sftpSessionId,job.from,true);
        else await sftpApi.renameEntry(session.sftpSessionId,job.from,job.to!);
        completed++;
      }catch(error){throw new Error(`${job.name}：${error instanceof Error?error.message:'操作失败'}${completed?`（此前已完成 ${completed} 项）`:''}`);}
    }
    return completed;
  }finally{await sftpApi.close(session.sftpSessionId).catch(()=>{});}
}
