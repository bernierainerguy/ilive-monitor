import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// RTL only auto-cleans when test globals are enabled; we keep globals off.
afterEach(async () => {
  if (typeof document !== 'undefined') (await import('@testing-library/react')).cleanup();
});

if (typeof window !== 'undefined') {
  // Lazy-loaded screens can take >1 s to appear under full-suite + coverage load.
  void import('@testing-library/react').then(({ configure }) => configure({ asyncUtilTimeout: 5000 }));

  // jsdom has no canvas. A permissive fake 2D context lets meter / EQ draw code
  // actually execute (and be covered) instead of bailing out on a null context.
  const fakeCtx = () =>
    new Proxy({ measureText: () => ({ width: 0 }) } as Record<string | symbol, unknown>, {
      get: (t, p) => (p in t ? t[p] : (t[p] = () => undefined)),
      set: (t, p, v) => ((t[p] = v), true),
    });
  HTMLCanvasElement.prototype.getContext = function () {
    return fakeCtx();
  } as never;

  globalThis.ResizeObserver ??= class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      this.cb([{ target: el, contentRect: { width: 1200, height: 700 } } as unknown as ResizeObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
  } as never;

  if (!crypto.randomUUID) {
    (crypto as { randomUUID: () => string }).randomUUID = () => `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  }
  // jsdom has no PointerEvent; without it clientX/clientY/pointerId are silently dropped.
  if (!('PointerEvent' in window)) {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
  }
  // Element.setPointerCapture isn't implemented in jsdom.
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
}
