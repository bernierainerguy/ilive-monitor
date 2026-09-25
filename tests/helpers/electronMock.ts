import { vi } from 'vitest';

/**
 * Minimal Electron stand-in for main-process modules under test.
 * Usage in a test file:  vi.mock('electron', () => import('../helpers/electronMock'));
 */
type Handler = (e: { sender: { id: number } }, req: unknown) => unknown;
export const handlers = new Map<string, Handler>();

export const ipcMain = {
  handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
};

export const shell = { openExternal: vi.fn() };

export const app = { getPath: () => '/tmp', isPackaged: false };
