import type { RackTarget } from '@shared/settings';
import { parseMixConfig } from '@shared/mixLayout';
import type { MixRackProtocol } from './MixRackProtocol';
import { IliveMidiProtocol } from './ilive-midi/IliveMidiProtocol';
import { ILIVE_TCP_PORT } from './ilive-midi/constants';
import { SimulatedRack, SimulatorProtocol } from './simulator/SimulatorProtocol';
import { TcpTransport } from '../transport/TcpTransport';

/** One virtual rack per app run, so reconnecting finds the same "hardware" state. */
let simulatedRack: SimulatedRack | null = null;

export function createProtocol(t: RackTarget): MixRackProtocol {
  switch (t.protocol) {
    case 'simulator':
      simulatedRack ??= new SimulatedRack();
      return new SimulatorProtocol(simulatedRack, { meterFps: 30 });
    case 'ilive-midi-tcp':
      return new IliveMidiProtocol(new TcpTransport({ host: t.host, port: t.port || ILIVE_TCP_PORT, connectTimeoutMs: 2500 }), {
        midiChannel: t.midiChannel,
        rackName: t.name,
        mixConfig: parseMixConfig(t.mixConfig) ?? undefined,
      });
    default:
      throw new Error(`Unknown rack protocol "${String((t as { protocol: unknown }).protocol)}"`);
  }
}
