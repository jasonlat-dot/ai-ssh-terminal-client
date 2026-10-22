export type NoticeType = 'info' | 'error' | 'success';
export type Notice = { id: number; message: string; type: NoticeType; durationMs?: number; key?: string };
export type PendingNotice = (() => void) & { finish: (message: string, type?: NoticeType, durationMs?: number) => void };

let sequence = 0;
let notices: Notice[] = [];
const subscribers = new Set<() => void>();
const publish = (next: Notice[]) => { notices = next; subscribers.forEach(listener => listener()); };

export const readNotices = () => notices;
export function subscribeNotices(listener: () => void) {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}
export function notify(message: string, type: NoticeType = 'info', durationMs?: number, key?: string): void {
  if (!message.trim()) return;
  const duplicate = notices.find(item => key ? item.key === key : !item.key && item.message === message && item.type === type);
  const notice: Notice = { id: duplicate?.id ?? ++sequence, message, type, ...(key ? { key } : {}),
    durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : type === 'error' ? 6000 : 3500 };
  publish([...notices.filter(item => item.id !== notice.id), notice].slice(-4));
}
/** The same operation replaces its pending state with its result, even while hovered.
 * An old attempt cannot remove or overwrite a newer attempt using the same key. */
export function beginNotice(message: string, options: { key?: string } = {}): PendingNotice {
  if (!message.trim()) return Object.assign(() => {}, { finish: () => {} });
  const id = (options.key && notices.find(item => item.key === options.key)?.id) || ++sequence;
  const notice: Notice = { id, message, type: 'info', durationMs: 0, key: options.key };
  let settled = false;
  const ownsNotice = () => notices.some(item => item === notice);
  const close = () => {
    if (settled) return;
    settled = true;
    if (ownsNotice()) dismissNotice(id);
  };
  const finish = (result: string, type: NoticeType = 'success', durationMs?: number) => {
    if (!result.trim()) { close(); return; }
    if (settled) return;
    settled = true;
    if (ownsNotice()) publish(notices.map(item => item === notice ? { ...notice, message: result, type,
      durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : type === 'error' ? 6000 : 3500 } : item));
  };
  publish([...notices.filter(item => item.id !== id), notice].slice(-4));
  return Object.assign(close, { finish });
}
export function dismissNotice(id: number): void {
  if (notices.some(item => item.id === id)) publish(notices.filter(item => item.id !== id));
}
