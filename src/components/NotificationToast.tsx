import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from './Ui';

export type NoticeType = 'info' | 'error' | 'success';
export type Notice = { id: number; message: string; type: NoticeType; durationMs?: number };
export const DEFAULT_NOTICE_DURATION_MS = 5000;

export function NotificationToast({ notice, close, durationMs = DEFAULT_NOTICE_DURATION_MS }: { notice: Notice; close: () => void; durationMs?: number }) {
  const [details, setDetails] = useState(false);
  const closeAfter = notice.durationMs ?? durationMs;
  useEffect(() => {
    const timer = setTimeout(close, closeAfter);
    return () => clearTimeout(timer);
  }, [notice, closeAfter, close]);
  const networkError = notice.type === 'error' && notice.message.includes('无法访问 SSH 服务');
  const title = networkError ? '无法访问 SSH 服务' : { info: '提示', error: '操作失败', success: '操作成功' }[notice.type];
  return <div className={`notification-toast notification-${notice.type}`} style={{ '--notice-duration': `${closeAfter}ms` } as CSSProperties}>
    <span className="notification-symbol"><Icon name={notice.type === 'success' ? 'check' : notice.type === 'error' ? (networkError ? 'network' : 'close') : 'bulb'} size={20} /></span>
    <div className="notification-content" role={notice.type === 'error' ? 'alert' : 'status'} aria-atomic="true"><strong>{title}</strong><p>{networkError ? '请检查后端地址、服务状态和网络连接。' : notice.message}</p></div>
    {notice.type === 'error' && <button className="notification-action" aria-expanded={details} aria-controls={`notice-${notice.id}`} onClick={() => setDetails(value => !value)}>{details ? '收起详情' : '查看详情'}</button>}
    <button className="notification-close" aria-label="关闭提示" onClick={close}><Icon name="close" size={16} /></button>
    {details && <div className="notification-details" id={`notice-${notice.id}`}>{notice.message}</div>}
  </div>;
}
