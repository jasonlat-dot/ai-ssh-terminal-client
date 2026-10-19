import type { ChatMessage } from '../types';
import { useRef, useState } from 'react';
import { chatErrorGuidance } from '../api/chatErrors';
import { revealRequestLog } from '../api/requestLogs';
import { isTauriRuntime } from '../state/runtime';
import { Icon } from './Ui';
import { CopyTextButton } from './CopyTextButton';
import './ChatFailure.css';

/** Failure belongs to its turn, including after history is reloaded. Never resends. */
export function ChatFailure({message, traceId, disabled, restore}: {
  message:ChatMessage; traceId?:string; disabled:boolean; restore:()=>void;
}) {
  const [locating, setLocating] = useState(false);
  const [logError, setLogError] = useState('');
  const locatingRef = useRef(false);
  const locateLog = async () => {
    if (!traceId || locatingRef.current) return;
    locatingRef.current = true; setLocating(true); setLogError('');
    try { await revealRequestLog(traceId); }
    catch (cause) { setLogError(cause instanceof Error ? cause.message : '定位日志失败，请重试。'); }
    finally { locatingRef.current = false; setLocating(false); }
  };
  return <section className="chat-failure" aria-label="回复未完成">
    <div className="chat-failure-heading"><Icon name="alert" size={17}/><strong>本次回复未完成</strong></div>
    {message.errorMessage && <p className="chat-failure-detail">{message.errorMessage}</p>}
    <p className="chat-failure-guidance">{chatErrorGuidance(message.errorCode)}</p>
    <p className="chat-failure-retained">{message.errorLocalOnly
      ? '请求尚未保存到工作区，文字和附件暂留在当前页面。'
      : '本次请求、附件及已有工具记录已保留在对话中。'}不会自动重发或重新执行命令。</p>
    <div className="chat-failure-footer">
      {traceId && <div className="chat-failure-trace"><span>Trace ID</span><code>{traceId}</code><CopyTextButton getText={()=>traceId} label="复制 Trace ID" iconOnly/></div>}
      <div className="chat-failure-actions">
        {traceId && isTauriRuntime() && <button type="button" className="chat-failure-locate" disabled={locating} aria-busy={locating} onClick={()=>void locateLog()} title="在文件管理器中选中这次请求的日志"><Icon name="folder" size={14}/>{locating ? '正在定位…' : '定位日志'}</button>}
        <button type="button" className="chat-failure-restore" disabled={disabled} onClick={restore}><Icon name="edit" size={14}/>恢复到输入框</button>
      </div>
    </div>
    {logError && <p className="chat-failure-log-error" role="status">{logError}</p>}
  </section>;
}
