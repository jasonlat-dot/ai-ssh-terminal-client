import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Ui';

type Feedback = { id: number; message: string; kind: 'success' | 'info' | 'error' };

export function useClipboardFeedback() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);
  const clearFeedback = useCallback(() => {
    clearTimeout(timer.current);
    if (mounted.current) setFeedback(null);
  }, []);
  const showFeedback = useCallback((message: string, kind: Feedback['kind'] = 'success') => {
    if (!mounted.current) return;
    clearTimeout(timer.current);
    setFeedback({ id: ++sequence.current, message, kind });
    timer.current = setTimeout(() => setFeedback(null), kind === 'error' ? 3500 : 2200);
  }, []);
  return { feedback, showFeedback, clearFeedback };
}

export function ClipboardFeedback({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  return <span key={feedback.id} className={`clipboard-feedback ${feedback.kind}`} role="status" aria-atomic="true">
    <Icon name={feedback.kind === 'success' ? 'check' : feedback.kind === 'error' ? 'alert' : 'paste'} size={13} />
    <span>{feedback.message}</span>
  </span>;
}
