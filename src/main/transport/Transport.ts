export type TransportState = 'closed' | 'opening' | 'open';

/** Byte-stream transport. Knows nothing about MIDI or mixers. */
export interface Transport {
  readonly state: TransportState;
  readonly remoteAddress: string;
  open(): Promise<void>;
  close(): void;
  write(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): () => void;
  /** Fires once per open() when the link drops, with the cause if known. */
  onClose(cb: (err?: Error) => void): () => void;
}

/** Minimal typed emitter used across main-process modules (no Node EventEmitter leaks). */
export class Emitter<T> {
  private listeners = new Set<(v: T) => void>();
  on(cb: (v: T) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(v: T): void {
    for (const l of [...this.listeners]) l(v);
  }
  clear(): void {
    this.listeners.clear();
  }
  get size(): number {
    return this.listeners.size;
  }
}
