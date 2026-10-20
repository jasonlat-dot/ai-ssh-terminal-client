import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { dismissNotice, readNotices, subscribeNotices } from '../state/notifications';
import type { Notice } from '../state/notifications';
import { Icon } from './Ui';

export type { Notice, NoticeType } from '../state/notifications';
export const DEFAULT_NOTICE_DURATION_MS = 3500;

export function NotificationToast({ notice, close, durationMs = DEFAULT_NOTICE_DURATION_MS }: { notice: Notice; close: () => void; durationMs?: number }) {
  const [details, setDetails] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const closeRef = useRef(close);
  closeRef.current = close;
  const closeAfter = notice.durationMs ?? durationMs;
  useEffect(() => {
    if (closeAfter <= 0 || hovered || focused || details) return;
    const timer = setTimeout(() => closeRef.current(), closeAfter);
    return () => clearTimeout(timer);
  }, [notice, closeAfter, hovered, focused, details]);
  const networkError = notice.type === 'error' && notice.message.includes('无法访问 SSH 服务');
  return <div className={`notification-toast notification-${notice.type}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span className="notification-symbol"><Icon name={notice.type === 'success' ? 'check' : notice.type === 'error' ? 'alert' : 'bulb'} size={16} /></span>
    <div className="notification-content" role={notice.type === 'error' ? 'alert' : 'status'} aria-atomic="true"><p>{networkError ? '无法访问 SSH 服务，请检查后端地址和网络。' : notice.message}</p></div>
    {networkError && <button className="notification-action" aria-expanded={details} aria-controls={`notice-${notice.id}`} onClick={() => setDetails(value => !value)}>{details ? '收起' : '详情'}</button>}
    <button className="notification-close" aria-label="关闭提示" onClick={close}><Icon name="close" size={16} /></button>
    {details && <div className="notification-details" id={`notice-${notice.id}`}>{notice.message}</div>}
  </div>;
}

export function NotificationCenter() {
  const notices = useSyncExternalStore(subscribeNotices, readNotices, readNotices);
  return createPortal(<div className="notification-center" aria-label="操作提示">
    {notices.map(notice => <NotificationToast key={notice.id} notice={notice} close={() => dismissNotice(notice.id)} />)}
  </div>, document.body);
}
