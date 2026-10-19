import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from './notifications';

/** Keep recovery/invalid state locally; polling can suppress an unchanged failure. */
export function useToastError({ suppressRepeated = false }: { suppressRepeated?: boolean } = {}) {
  const [error, updateError] = useState('');
  const reported = useRef('');
  const setError = useCallback((message: string) => {
    updateError(message);
    if (message && (!suppressRepeated || message !== reported.current)) notify(message, 'error');
    reported.current = message;
  }, [suppressRepeated]);
  return [error, setError] as const;
}

/** Bridge errors owned by an external store without notifying during render. */
export function useErrorToast(error: string | null | undefined) {
  useEffect(() => { if (error) notify(error, 'error'); }, [error]);
}
