import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
const Context = createContext<{ roots: Record<string, HTMLElement | null>; register: (id: string, element: HTMLElement | null) => void }>({ roots: {}, register: () => {} });
export function InspectorProvider({ children }: { children: ReactNode }) {
  const [roots, setRoots] = useState<Record<string, HTMLElement | null>>({});
  const register = useCallback((id: string, element: HTMLElement | null) => setRoots(current => current[id] === element ? current : { ...current, [id]: element }), []);
  return <Context.Provider value={{ roots, register }}>{children}</Context.Provider>;
}
export function InspectorSlot({ id }: { id: string }) {
  const { register } = useContext(Context);
  const ref = useCallback((element: HTMLDivElement | null) => register(id, element), [id, register]);
  return <div ref={ref} />;
}
export const useInspectorRoot = (id: string, active: boolean) => {
  const { roots } = useContext(Context);
  return active ? roots[id] ?? null : null;
};
