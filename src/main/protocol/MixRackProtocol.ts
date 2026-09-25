import type { MixerChange } from '@shared/domain/changes';
import type { MixerState } from '@shared/domain/model';
import type { ProtocolCapabilities, RackIdentity } from '@shared/rack';

/**
 * Protocol layer contract. A protocol turns MixerChanges into wire traffic and
 * wire traffic into MixerChanges. It owns (but does not create) its transport.
 *
 * Everything above this interface is protocol-agnostic, so the documented
 * iLive MIDI-over-TCP protocol, the built-in simulator, or a future full surface
 * protocol are interchangeable without touching services or UI.
 */
export interface MixRackProtocol {
  readonly id: string;
  readonly capabilities: ProtocolCapabilities;

  /** Open transport and identify the rack. Rejects if the rack does not answer. */
  open(): Promise<RackIdentity>;
  close(): void;

  /** Whether this protocol can express the change on the wire. */
  supports(change: MixerChange): boolean;
  /**
   * The level the rack will actually hold for `db`, after its own rounding (iLive MIDI: 0.5 dB steps, and nothing
   * quieter than about -53 dB except off). Absent: levels arrive exactly as sent.
   */
  normaliseLevel?(db: number): number;
  /** Encode and write. Caller must check `supports` first. */
  send(change: MixerChange): void;
  recallScene(sceneNumber: number): void;

  /** Round-trip probe used by the watchdog. Resolves with RTT in ms. */
  probe(timeoutMs: number): Promise<number>;

  /**
   * Ask the rack for as much current state as the protocol allows and fold the
   * answers in via `onChange`. Resolves once outstanding queries have settled.
   */
  requestState(current: MixerState): Promise<void>;

  onChange(cb: (change: MixerChange) => void): () => void;
  onMeters(cb: (frame: Float32Array) => void): () => void;
  onRemoteSceneRecall(cb: (sceneNumber: number) => void): () => void;
  /** Link lost. Fires at most once per open(). */
  onClose(cb: (err?: Error) => void): () => void;
}
