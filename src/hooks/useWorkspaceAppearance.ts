import { useEffect, useState } from 'react';
import { useUIStore } from '../stores/useUIStore';

export function useWorkspaceAppearance() {
  const setDarkMode = useUIStore(state => state.setDarkMode);
  const darkMode = useUIStore(state => state.darkMode);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    try { const saved = localStorage.getItem('dataset-creator-theme'); return saved === 'light' || saved === 'dark' ? saved : 'system'; } catch { return 'system'; }
  });
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setDarkMode(theme === 'dark' || (theme === 'system' && media.matches));
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('dataset-creator-theme', theme); } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme, setDarkMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  return { theme, setTheme };
}
