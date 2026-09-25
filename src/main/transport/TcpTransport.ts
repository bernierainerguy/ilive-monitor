import { Socket } from 'node:net';
import { Emitter, type Transport, type TransportState } from './Transport';

export interface TcpOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
}

/**
 * TCP transport tuned for control traffic: Nagle disabled (latency over
 * throughput) and OS keep-alive as a second line of defence behind the protocol
 * watchdog.
 */
export class TcpTransport implements Transport {
  private socket: Socket | null = null;
  private _state: TransportState = 'closed';
  private readonly data = new Emitter<Uint8Array>();
  private readonly closed = new Emitter<Error | undefined>();

  constructor(private readonly opts: TcpOptions) {}

  get state(): TransportState {
    return this._state;
  }
  get remoteAddress(): string {
    return `${this.opts.host}:${this.opts.port}`;
  }

  open(): Promise<void> {
    if (this._state !== 'closed') return Promise.reject(new Error('transport already open'));
    this._state = 'opening';
    return new Promise((resolve, reject) => {
      const s = new Socket();
      this.socket = s;
      let settled = false;
      const timer = setTimeout(() => fail(new Error(`connect timeout to ${this.remoteAddress}`)), this.opts.connectTimeoutMs ?? 3000);

      const fail = (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          this.teardown();
          reject(err);
        }
      };

      s.setNoDelay(true);
      s.setKeepAlive(true, 1000);
      s.once('connect', () => {
        clearTimeout(timer);
        settled = true;
        this._state = 'open';
        resolve();
      });
      s.on('data', (buf: Buffer) => this.data.emit(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
      s.on('error', (err) => {
        if (!settled) fail(err);
        else this.drop(err);
      });
      s.on('close', () => this.drop());
      s.connect(this.opts.port, this.opts.host);
    });
  }

  write(bytes: Uint8Array): void {
    if (this._state !== 'open' || !this.socket) throw new Error('transport not open');
    this.socket.write(bytes);
  }

  close(): void {
    this.teardown();
  }

  onData(cb: (b: Uint8Array) => void) {
    return this.data.on(cb);
  }
  onClose(cb: (err?: Error) => void) {
    return this.closed.on(cb);
  }

  private drop(err?: Error) {
    if (this._state === 'closed') return;
    this.teardown();
    this.closed.emit(err);
  }

  private teardown() {
    this._state = 'closed';
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.removeAllListeners();
      s.on('error', () => undefined); // swallow late errors after teardown
      s.destroy();
    }
  }
}
