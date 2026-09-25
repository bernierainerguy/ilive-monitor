/** Settings password state, as the window sees it. The hash never leaves the main process. */
export interface LockStatus {
  /** A Settings password is set. */
  hasPassword: boolean;
  /** Settings may be changed now: no password, or it was entered and Settings hasn't been left since. */
  unlocked: boolean;
  /** After repeated wrong passwords, when the next attempt is allowed (epoch ms), else null. */
  retryAt: number | null;
}

export const MIN_PASSWORD_LENGTH = 4;
