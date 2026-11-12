import { useEffect, useState } from 'react';
import { useUIStore } from '../stores/useUIStore';

export function useWorkspaceAppearance() {
  const setDarkMode = useUIStore(state => state.setDarkMode);
  const darkMode = useUIStore(state => state.darkMode);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    try { const saved = localStorage.getItem('dataset-creator-theme'); return saved === 'light' || saved === 'dark' ? saved : 'system'; } catch { return 'system'; }
  });
  const [density, setDensity] = useState(() => { try { return localStorage.getItem('dataset-creator-density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; } });
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setDarkMode(theme === 'dark' || (theme === 'system' && media.matches));
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('dataset-creator-theme', theme); } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme, setDarkMode]);
  useEffect(() => { document.documentElement.dataset.density = density; try { localStorage.setItem('dataset-creator-density', density); } catch {} }, [density]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  return { theme, setTheme, density, setDensity };
}
