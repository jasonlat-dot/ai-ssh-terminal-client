import type {SftpItem,SftpTransfer} from '../api/sftp';

export function transferIdentity(task:SftpTransfer){
  const root=task.items.reduce<SftpItem|undefined>((root,item)=>!root||item.relativePath.split('/').length<root.relativePath.split('/').length?item:root,undefined);
  const relativePath=root?.relativePath||'正在准备文件清单';
  return {name:relativePath.split('/').filter(Boolean).pop()||relativePath,relativePath,
    kind:root?.kind, fileCount:task.items.filter(item=>item.kind==='FILE').length,
    directoryCount:task.items.filter(item=>item.kind==='DIRECTORY').length,
    location:task.direction==='UPLOAD'?`上传到 ${task.remotePath}`:`来自 ${task.remotePath}`};
}

/** Progress events contain live running items; full task snapshots arrive after
 * transitions. Overlay only that task's active items, never infer completion from bytes. */
export function transferItems(task:SftpTransfer,localBytes:Record<string,number>={}){
  const active=new Map(task.progress.activeItems.map(item=>[item.itemId,item]));
  return task.items.map(saved=>{
    let item=active.get(saved.itemId)??saved;
    if(task.progress.status==='CANCELLED'&&!['COMPLETED','SKIPPED','FAILED'].includes(item.status))item={...item,status:'CANCELLED'};
    if(task.direction==='DOWNLOAD'&&['RUNNING','SENT'].includes(item.status)&&localBytes[item.itemId]!==undefined)
      item={...item,transferredBytes:Math.min(item.size,Math.max(0,localBytes[item.itemId]))};
    return item;
  });
}

export const transferItemStatus:Record<string,string>={PENDING:'等待传输',RUNNING:'正在传输',SENT:'待本地保存确认',COMPLETED:'已完成',SKIPPED:'已跳过',FAILED:'失败',CANCELLED:'已取消'};
export const transferItemKind:Record<string,string>={FILE:'文件',DIRECTORY:'目录',SYMLINK:'链接',OTHER:'其他'};
export const itemUnfinished=(item:SftpItem)=>!['COMPLETED','SKIPPED'].includes(item.status);
export function itemPercent(item:SftpItem):number|null{
  if(item.kind!=='FILE'||item.status==='SKIPPED')return null;
  if(item.status==='COMPLETED')return 100;
  return item.size>0?Math.min(100,Math.max(0,Math.floor(item.transferredBytes/item.size*100))):null;
}
