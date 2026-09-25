import { Emitter, type Transport, type TransportState } from './Transport';

/**
 * In-memory transport pair for tests and the rack emulator. `peer` receives what
 * the transport writes and can inject bytes back.
 */
export class LoopbackTransport implements Transport {
  private _state: TransportState = 'closed';
  private readonly data = new Emitter<Uint8Array>();
  private readonly closed = new Emitter<Error | undefined>();
  readonly written: Uint8Array[] = [];
  /** Set to make open() fail, simulating an unreachable rack. */
  refuse = false;
  private readonly peerRx = new Emitter<Uint8Array>();

  readonly remoteAddress = 'loopback';

  get state(): TransportState {
    return this._state;
  }

  async open(): Promise<void> {
    if (this.refuse) throw new Error('ECONNREFUSED (loopback)');
    this._state = 'open';
  }

  close(): void {
    this._state = 'closed';
  }

  write(bytes: Uint8Array): void {
    if (this._state !== 'open') throw new Error('transport not open');
    this.written.push(bytes);
    this.peerRx.emit(bytes);
  }

  onData(cb: (b: Uint8Array) => void) {
    return this.data.on(cb);
  }
  onClose(cb: (err?: Error) => void) {
    return this.closed.on(cb);
  }

  // --- peer side -----------------------------------------------------------
  readonly peer = {
    send: (bytes: Uint8Array | number[]) => this.data.emit(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)),
    onReceive: (cb: (b: Uint8Array) => void) => this.peerRx.on(cb),
    drop: (err?: Error) => {
      if (this._state === 'closed') return;
      this._state = 'closed';
      this.closed.emit(err);
    },
  };
}
