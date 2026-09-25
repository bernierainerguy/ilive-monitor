import type { Logger } from '../logging/Logger';
import { readJson, writeJsonAtomic } from '../storage/JsonStore';
import { Emitter } from '../transport/Transport';
import type { LegalView } from '@shared/licence';

/**
 * EULA acceptance, independent of licensing (as in WESC). Acceptance matches the
 * exact version, so bumping this re-prompts every user: do it when legal/WEIM-EULA.md
 * is materially revised, not for typos. Keep EFFECTIVE in scripts/build-legal-pdfs.py
 * and the version line in the EULA in step (tests/unit/licence.test.ts checks).
 */
export const EULA_VERSION = '2026-09-25';

interface Acceptance {
  version: string;
  acceptedAt: string;
}

export class LegalService {
  readonly changed = new Emitter<LegalView>();
  private acceptance: Acceptance | null = null;

  constructor(private readonly path: string, private readonly log: Logger, private readonly now: () => number = Date.now) {}

  async init(): Promise<LegalView> {
    try {
      this.acceptance = await readJson<Acceptance>(this.path);
    } catch {
      this.acceptance = null; // unreadable → ask again
    }
    return this.view;
  }

  get accepted(): boolean {
    return this.acceptance?.version === EULA_VERSION;
  }

  get view(): LegalView {
    return { eulaVersion: EULA_VERSION, accepted: this.accepted, acceptedAt: this.accepted ? this.acceptance!.acceptedAt : null };
  }

  async accept(): Promise<LegalView> {
    this.acceptance = { version: EULA_VERSION, acceptedAt: new Date(this.now()).toISOString() };
    this.log.info('system', `EULA ${EULA_VERSION} accepted`);
    // If the disk refuses, accept for this session anyway (and ask again next launch) rather than trap the
    // operator behind the dialog; always broadcast, so main and every window agree.
    await writeJsonAtomic(this.path, this.acceptance).catch((err) =>
      this.log.error('system', `Could not save EULA acceptance (will ask again next launch): ${(err as Error).message}`));
    this.changed.emit(this.view);
    return this.view;
  }
}
