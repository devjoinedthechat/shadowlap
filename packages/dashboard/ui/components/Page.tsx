import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A scrolling page. A page's scrollbar takes width from its right side; giving that width back in
 * the padding (`--sbw`) keeps the content's right edge under the top bar's, with or without one.
 * `busy` while what it opened for still loads, its heading over a line that says so: the heading
 * takes the focus once the page has drawn it (focus-manager.ts), so Tab goes on into the page.
 */
export function Page({ children, className = '', busy = false }: { children: ReactNode; className?: string; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pg = ref.current;
    if (!pg) return;
    const fit = () => pg.style.setProperty('--sbw', `${pg.offsetWidth - pg.clientWidth}px`);
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    if (inner.current) ro?.observe(inner.current);
    ro?.observe(pg);
    window.addEventListener('resize', fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);
  return (
    <div className="page" ref={ref} tabIndex={-1} {...(busy ? { 'aria-busy': true } : {})}>
      <div className={`page-in${className ? ` ${className}` : ''}`} ref={inner}>
        {children}
      </div>
    </div>
  );
}
