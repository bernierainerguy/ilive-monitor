import type { MixerChange } from '@shared/domain/changes';
import type { DispatchResult } from '@shared/ipc';
import { authorizeMonitorChange } from '@shared/monitorPolicy';
import type { Logger } from '../logging/Logger';
import type { RackSession } from '../rack/RackSession';
import type { StateCache } from '../rack/StateCache';

/**
 * The single write path for mixer state, and the lock that makes this a
 * monitor-only app. Every change from the renderer must be a send level to the
 * bus chosen in Settings (`authorizeMonitorChange`) and must reach the rack now:
 * with no show to edit, a change the rack can't take would only be a lie on screen.
 */
export class MixerService {
  constructor(
    private readonly cache: StateCache,
    private readonly session: RackSession,
    private readonly log: Logger,
    private readonly bus: () => number | null,
  ) {}

  dispatch(changes: readonly MixerChange[], origin = 'ui'): DispatchResult {
    const bus = this.bus();
    const accepted: MixerChange[] = [];
    const rejected: DispatchResult['rejected'] = [];
    changes.forEach((c, index) => {
      const r = authorizeMonitorChange(this.cache.state, bus, c);
      if (!r.ok) rejected.push({ index, reason: r.reason });
      else if (!this.session.supports(c)) rejected.push({ index, reason: 'Not connected to the rack' });
      // What the rack will actually hold (-70 is -53.5 on iLive MIDI): the screen shows the truth, not the ask.
      else accepted.push(c.t === 'send' && c.patch.levelDb !== undefined ? { ...c, patch: { levelDb: this.session.normaliseLevel(c.patch.levelDb) } } : c);
    });
    if (rejected.length) this.log.warn('user', `Rejected ${rejected.length} change(s)`, { reason: rejected[0]?.reason, origin });
    if (!accepted.length) return { accepted: 0, rejected };

    this.cache.apply(accepted);
    this.session.send(accepted);
    return { accepted: accepted.length, rejected };
  }
}
