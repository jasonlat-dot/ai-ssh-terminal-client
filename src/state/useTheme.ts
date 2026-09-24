import { useLayoutEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const storageKey = 'agent-ssh-theme';

function readTheme(): ThemePreference {
  const saved = localStorage.getItem(storageKey);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  return preference === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : preference;
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemePreference>(readTheme);

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = resolveTheme(theme);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themePreference = theme;
      document.documentElement.style.colorScheme = resolved;
    };

    localStorage.setItem(storageKey, theme);
    apply();
    if (theme === 'system') media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return { theme, setTheme };
}
