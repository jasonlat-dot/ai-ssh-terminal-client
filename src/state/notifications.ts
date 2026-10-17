export type NoticeType = 'info' | 'error' | 'success';
export type Notice = { id: number; message: string; type: NoticeType; durationMs?: number };

let sequence = 0;
let notices: Notice[] = [];
const subscribers = new Set<() => void>();
const publish = (next: Notice[]) => { notices = next; subscribers.forEach(listener => listener()); };

export const readNotices = () => notices;
export function subscribeNotices(listener: () => void) {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}
export function notify(message: string, type: NoticeType = 'info', durationMs?: number): void {
  if (!message.trim()) return;
  const duplicate = notices.find(item => item.message === message && item.type === type);
  const notice: Notice = { id: duplicate?.id ?? ++sequence, message, type,
    durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : type === 'error' ? 6000 : 3500 };
  publish([...notices.filter(item => item.id !== notice.id), notice].slice(-4));
}
export function dismissNotice(id: number): void {
  if (notices.some(item => item.id === id)) publish(notices.filter(item => item.id !== id));
}
