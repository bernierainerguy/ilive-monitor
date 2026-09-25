import { coalesceKey, type MixerChange } from '@shared/domain/changes';
import { authorizeMonitorChange } from '@shared/monitorPolicy';
import { invoke } from '../api/bridge';
import { useAppStore } from '../state/appStore';
import { useMixerStore } from '../state/mixerStore';

/**
 * Renderer-side command service. Every fader calls `dispatch`:
 *  1. cosmetic policy check (main re-checks authoritatively),
 *  2. optimistic local apply so the fader feels instant,
 *  3. coalesced, batched send to main (one IPC per ~8 ms, latest value wins).
 */
const FLUSH_MS = 8;
let queue: MixerChange[] = [];
const byKey = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function dispatch(...changes: MixerChange[]): boolean {
  const state = useMixerStore.getState().state;
  const bus = useAppStore.getState().settings?.bus ?? null;
  const allowed = state ? changes.filter((c) => authorizeMonitorChange(state, bus, c).ok) : [];
  if (!allowed.length) return false;
  useMixerStore.getState().applyLocal(allowed);
  for (const c of allowed) {
    const k = coalesceKey(c);
    if (k && byKey.has(k)) queue[byKey.get(k)!] = c;
    else {
      if (k) byKey.set(k, queue.length);
      queue.push(c);
    }
  }
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
  return true;
}

export async function flush(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  byKey.clear();
  try {
    const r = await invoke('mixer:dispatch', batch);
    if (r.rejected.length) {
      useAppStore.getState().notify(r.rejected[0]!.reason, 'warning');
      await resnapshot(); // the optimistic value never reached the rack: show what's really there
    }
  } catch (err) {
    useAppStore.getState().notify(`Command failed: ${(err as Error).message}`, 'error');
    await resnapshot();
  }
}

export async function resnapshot(): Promise<void> {
  const { seq, state } = await invoke('mixer:snapshot', undefined);
  useMixerStore.getState().reset(seq, state);
}

// A move in the last 8 ms before the window closes still goes out.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void flush());
