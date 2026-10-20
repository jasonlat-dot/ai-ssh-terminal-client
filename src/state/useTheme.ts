import { useLayoutEffect, useState } from 'react';
import type { ThemePreference } from './themes';

export type { ThemePreference } from './themes';

const storageKey = 'agent-ssh-theme';

function readTheme(): ThemePreference {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark' || saved === 'night') return saved;
    // Migrate the former system preference once; never subscribe to OS changes.
    if (saved === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch { /* Unavailable preferences must not prevent startup. */ }
  return 'light';
}

export function useTheme() {
  const [savedTheme, setTheme] = useState<ThemePreference>(readTheme);
  // Existing development windows can retain the old "system" state across hot reload.
  const theme = savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'night' ? savedTheme : readTheme();

  useLayoutEffect(() => {
    const resolved = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = theme;
    document.documentElement.style.colorScheme = resolved;
    try { localStorage.setItem(storageKey, theme); } catch { /* Keep the chosen theme usable in this window. */ }
  }, [theme]);

  return { theme, setTheme };
}
