import { useEffect, useState } from 'react';

function match(query: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

/** 小于 768px 视为移动端（钱包视图） */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => match('(max-width: 767px)'));

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
