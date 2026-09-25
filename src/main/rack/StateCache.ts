import { applyChange, type MixerChange } from '@shared/domain/changes';
import type { MixerState } from '@shared/domain/model';
import { Emitter } from '../transport/Transport';

export interface ChangeBatch {
  seq: number;
  changes: MixerChange[];
}

/**
 * The authoritative local cache ("primary source of truth" inside this app).
 * Every change from any source lands here first; renderers receive sequenced
 * batches and re-snapshot if they detect a gap.
 *
 * Batching: changes are folded immediately but broadcast once per `flushMs`
 * so a 64-fader scene recall is one IPC message, not 64.
 */
export class StateCache {
  private _state: MixerState;
  private _seq = 0;
  private pending: MixerChange[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private _version = 0;

  readonly batches = new Emitter<ChangeBatch>();
  readonly resets = new Emitter<{ seq: number; state: MixerState }>();

  constructor(
    initial: MixerState,
    private readonly flushMs = 8,
  ) {
    this._state = initial;
  }

  get state(): MixerState {
    return this._state;
  }
  /** Bumped by every applied change or replace; lets a slow save tell whether edits landed meanwhile. */
  get version(): number {
    return this._version;
  }

  get seq(): number {
    return this._seq;
  }
  /** True if changed since the last `markClean()` (drives show "dirty" + backup). */
  get isDirty(): boolean {
    return this.dirty;
  }
  markClean() {
    this.dirty = false;
  }

  apply(changes: readonly MixerChange[]): void {
    if (!changes.length) return;
    let next = this._state;
    for (const c of changes) next = applyChange(next, c);
    if (next === this._state) return; // all no-ops (e.g. rack echo of our own change)
    this._state = next;
    this._version++;
    this.dirty = true;
    this.pending.push(...changes);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  /** Replace the whole state (show open, backup restore). `dirty` marks it as an unsaved edit of the show. */
  replace(state: MixerState, opts: { dirty?: boolean } = {}): void {
    this.cancelFlush();
    if (opts.dirty) this.dirty = true;
    this.pending = [];
    this._state = state;
    this._version++;
    this._seq++;
    this.resets.emit({ seq: this._seq, state });
  }

  flush(): void {
    this.cancelFlush();
    if (!this.pending.length) return;
    const changes = this.pending;
    this.pending = [];
    this._seq++;
    this.batches.emit({ seq: this._seq, changes });
  }

  snapshot(): { seq: number; state: MixerState } {
    this.flush();
    return { seq: this._seq, state: this._state };
  }

  dispose() {
    this.cancelFlush();
    this.batches.clear();
    this.resets.clear();
  }

  private cancelFlush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
