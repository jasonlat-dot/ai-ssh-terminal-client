import { useEffect, useState } from 'react';
import { Icon } from './Ui';

export type NoticeType = 'info' | 'error' | 'success';
export type Notice = { id: number; message: string; type: NoticeType; durationMs?: number };
export const DEFAULT_NOTICE_DURATION_MS = 3500;

export function NotificationToast({ notice, close, durationMs = DEFAULT_NOTICE_DURATION_MS }: { notice: Notice; close: () => void; durationMs?: number }) {
  const [details, setDetails] = useState(false);
  const closeAfter = notice.durationMs ?? durationMs;
  useEffect(() => {
    const timer = setTimeout(close, closeAfter);
    return () => clearTimeout(timer);
  }, [notice, closeAfter, close]);
  const networkError = notice.type === 'error' && notice.message.includes('无法访问 SSH 服务');
  return <div className={`notification-toast notification-${notice.type}`}>
    <span className="notification-symbol"><Icon name={notice.type === 'success' ? 'check' : notice.type === 'error' ? 'alert' : 'bulb'} size={16} /></span>
    <div className="notification-content" role={notice.type === 'error' ? 'alert' : 'status'} aria-atomic="true"><p>{networkError ? '无法访问 SSH 服务，请检查后端地址和网络。' : notice.message}</p></div>
    {networkError && <button className="notification-action" aria-expanded={details} aria-controls={`notice-${notice.id}`} onClick={() => setDetails(value => !value)}>{details ? '收起' : '详情'}</button>}
    <button className="notification-close" aria-label="关闭提示" onClick={close}><Icon name="close" size={16} /></button>
    {details && <div className="notification-details" id={`notice-${notice.id}`}>{notice.message}</div>}
  </div>;
}
