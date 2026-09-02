import { useEffect, useState } from 'react';

export const useInspectorPortalRoot = (rootId: string, active = true): HTMLElement | null => {
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || typeof document === 'undefined') {
      setRoot(null);
      return;
    }

    const findRoot = () => {
      const nextRoot = document.getElementById(rootId);
      setRoot((currentRoot) => (currentRoot === nextRoot ? currentRoot : nextRoot));
    };

    findRoot();

    const observer = new MutationObserver(findRoot);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [active, rootId]);

  return root;
};
