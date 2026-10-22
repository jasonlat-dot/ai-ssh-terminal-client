import {useId,useState} from 'react';
import type {SftpTransfer} from '../api/sftp';
import {formatBytes,transferPercent,transferStatus} from '../state/sftp';
import {itemPercent,itemUnfinished,transferIdentity,transferItemKind,transferItemStatus,transferItems} from '../state/sftpTransferDetails';
import {Badge,Icon} from './Ui';

export function SftpTransferTask({task,localBytes={},error,ready,working,cancelling,retry,cancel}:{
  task:SftpTransfer;localBytes?:Record<string,number>;error?:string;ready:boolean;working:boolean;cancelling:boolean;retry:()=>void;cancel:()=>void;
}){
  const [expanded,setExpanded]=useState(false),[filter,setFilter]=useState<'all'|'unfinished'|'failed'>('all'),[limit,setLimit]=useState(100);
  const id=useId();
  const {progress}=task,percent=transferPercent(progress),identity=transferIdentity(task);
  const finished=['COMPLETED','CANCELLED'].includes(progress.status);
  const items=transferItems(task,localBytes),unfinished=items.filter(itemUnfinished).length,failed=items.filter(item=>item.status==='FAILED').length;
  const completed=items.filter(item=>item.kind==='FILE'&&item.status==='COMPLETED').length,skipped=items.filter(item=>item.kind==='FILE'&&item.status==='SKIPPED').length;
  const shown=items.filter(item=>filter==='all'||(filter==='unfinished'?itemUnfinished(item):item.status==='FAILED'));
  const received=Object.values(localBytes).reduce((sum,bytes)=>sum+bytes,0);
  const awaitingCommit=percent===100&&!finished&&progress.status!=='FAILED';
  return <article className={`sftp-task ${progress.status.toLowerCase()}`}>
    <div className="sftp-task-title">
      <span className="sftp-task-direction"><Icon name={task.direction==='UPLOAD'?'upload':'down'} size={14}/><strong>{task.direction==='UPLOAD'?'上传':'下载'}</strong></span>
      <span className="sftp-task-file"><span className="sftp-task-name"><span className="sftp-task-kind"><Icon name={identity.kind==='DIRECTORY'?'folder':'file'} size={12}/>{identity.kind?transferItemKind[identity.kind]:'准备中'}</span><strong title={identity.relativePath}>{identity.name}</strong></span><small title={task.remotePath}>{identity.location}</small></span>
      <Badge className="sftp-task-status" tone={progress.status==='COMPLETED'?'success':progress.status==='FAILED'?'danger':progress.status==='RUNNING'?'blue':progress.status==='CANCELLED'?'neutral':'amber'} icon={progress.status==='COMPLETED'?'check':progress.status==='FAILED'?'alert':progress.status==='RUNNING'?'refresh':progress.status==='CANCELLED'?'stop':'history'}>{transferStatus[progress.status]??progress.status}</Badge>
    </div>
    <div className="sftp-task-progress">{percent!==null&&<progress max={100} value={percent} aria-label={`${task.direction==='UPLOAD'?'上传':'下载'}字节进度`}/>}<span>{percent===null?`${progress.completedItems} / ${progress.totalItems} 项`:`${percent}% · ${formatBytes(progress.transferredBytes)} / ${formatBytes(progress.totalBytes)}`}</span></div>
    <footer><small>{identity.kind==='DIRECTORY'?`${identity.fileCount} 个文件 · ${identity.directoryCount} 个目录 · 文件已完成 ${completed}${skipped?` · 已跳过 ${skipped}`:''}`:`完成 ${progress.completedItems}/${progress.totalItems} 项`}{progress.failedItems>0&&` · 失败 ${progress.failedItems} 项`}{progress.awaitingConfirmation>0&&` · 待保存确认 ${progress.awaitingConfirmation} 项`}{task.direction==='DOWNLOAD'&&received>0&&` · 本机已接收 ${formatBytes(received)}`}{awaitingCommit&&' · 正在提交或等待确认'}</small><div className="inline-actions">{!finished&&<><button className="file-mini-action" disabled={!ready||working} title="重查状态后重试，已完成和已跳过的条目不会重复传输" onClick={retry}>重查并重试未完成项</button><button className="file-mini-action" disabled={!ready||cancelling} onClick={cancel}>{cancelling?'取消中…':'取消'}</button></>}</div></footer>
    {error&&progress.status!=='COMPLETED'&&<p className="sftp-task-error" role="status">{error}</p>}
    <details className="sftp-task-details" onToggle={event=>setExpanded(event.currentTarget.open)}>
      <summary>{identity.kind==='DIRECTORY'?'查看目录明细':'查看文件明细'}<small>{items.length} 项{unfinished>0?` · 未完成 ${unfinished} 项`:''}{failed>0?` · 失败 ${failed} 项`:''}</small></summary>
      {expanded&&<div className="sftp-task-detail-body">
        <div className="sftp-task-filters" role="group" aria-label="筛选传输条目">{([{value:'all',label:'全部',count:items.length},{value:'unfinished',label:'未完成',count:unfinished},{value:'failed',label:'失败',count:failed}] as const).map(option=><button key={option.value} type="button" aria-pressed={filter===option.value} onClick={()=>{setFilter(option.value);setLimit(100);}}>{option.label} {option.count}</button>)}</div>
        <p className="sftp-task-detail-note">{task.direction==='DOWNLOAD'?'收到全部字节后仍需本地保存确认，状态为“已完成”才表示保存成功。':'目录创建完成不代表内部文件完成；每个文件以“已完成”状态为准。'}{skipped>0&&'“已跳过”表示保留同名原文件，未传输本次内容。'}</p>
        <ul id={id} className="sftp-task-item-list" aria-label="传输条目明细">{shown.slice(0,limit).map(item=>{
          const percent=itemPercent(item),done=item.status==='COMPLETED',bad=item.status==='FAILED';
          return <li key={item.itemId} className={`sftp-task-item ${item.status.toLowerCase()}`}>
            <div className="sftp-task-item-name"><Icon name={item.kind==='DIRECTORY'?'folder':'file'} size={14}/><span>{transferItemKind[item.kind]??item.kind}</span><strong title={item.relativePath}>{item.relativePath}</strong></div>
            <div className="sftp-task-item-progress"><span className="sftp-task-item-status">{transferItemStatus[item.status]??item.status}</span>{item.kind==='FILE'&&<small>{item.status==='SKIPPED'?formatBytes(item.size):`${formatBytes(done?item.size:item.transferredBytes)} / ${formatBytes(item.size)}`}{percent!==null&&` · ${percent}%`}</small>}</div>
            {percent!==null&&<progress max={100} value={percent} aria-label={`${item.relativePath} 字节进度`}/>}
            {(bad||item.message||item.errorCode)&&<p className="sftp-task-item-error">{item.message||item.errorCode||'传输失败，请重查并重试未完成项。'}</p>}
          </li>;
        })}</ul>
        {!shown.length&&<p className="sftp-task-detail-empty">{filter==='failed'?'暂无失败条目':filter==='unfinished'?'所有条目均已完成或跳过':'暂无条目'}</p>}
        {shown.length>limit&&<button type="button" className="sftp-task-show-more" aria-controls={id} onClick={()=>setLimit(value=>value+100)}>已显示 {Math.min(limit,shown.length)} / {shown.length} 项，显示更多</button>}
      </div>}
    </details>
  </article>;
}
