/**
 * Licence and EULA state shared by main (LicenceService, LegalService) and the
 * renderer (first-run dialogs, launch gate, Settings → Licence).
 *
 * The model is WESC's permissive check-in: no keys, a UUID plus name, email and
 * machine name, a 30-day grace refreshed by every successful check-in. Unlike
 * WESC, a refusal is only ever enforced when the app starts — never over a
 * running mix, and never when the app is launched in show mode.
 */
export type LicenceReason = 'no-identity' | 'no-checkin' | 'granted' | 'grace-soon' | 'denied' | 'grace-expired';

export interface LicenceIdentity {
  name: string;
  email: string;
  machineName: string;
}

/** What the operator enters. The computer name is not theirs to choose: it always comes from macOS. */
export type LicenceRegistration = Pick<LicenceIdentity, 'name' | 'email'>;

export interface LicenceView {
  identity: LicenceIdentity | null;
  /** Short installation id, for support. */
  installId: string | null;
  status: 'unknown' | 'granted' | 'denied';
  deniedReason: string | null;
  lastCheckinAt: string | null;
  graceUntil: string | null;
  lastError: string | null;
  /** Current evaluation of local state. */
  reason: LicenceReason;
  allowed: boolean;
  graceDaysLeft: number | null;
  /** The launch gate for this session. Once open it stays open until the app quits. */
  launch: { allowed: boolean; reason: LicenceReason; showMode: boolean };
  checking: boolean;
  /** This Mac's name as macOS reports it; sent with every check-in. */
  machineName: string;
}

export interface LegalView {
  eulaVersion: string;
  accepted: boolean;
  acceptedAt: string | null;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
