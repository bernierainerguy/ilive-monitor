import type { ILiveBridge } from '../shared/ipc';

declare global {
  interface Window {
    ilive: ILiveBridge;
  }
}

export {};
