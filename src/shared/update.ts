/**
 * Update state shared by main (UpdateService) and renderer (top-bar pill, update
 * dialog, Settings → About). Modelled on ~/Developer/wesc-update-checks.md.
 */
export interface UpdateInfo {
  version: string;
  /** Installer to download, or null when the feed names none for this Mac (then only the page is offered). */
  url: string | null;
  filename: string | null;
  /** Download page, always on whiteleyevents.co.uk. */
  page: string;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error';
  current: string;
  available: UpdateInfo | null;
  progress: number | null;
  /** The downloaded installer, once saved to Downloads. */
  path: string | null;
  /** Why the last download failed. */
  error: string | null;
  /** Why the last "Check for Updates…" failed. Automatic checks fail silently and never set it. */
  checkError: string | null;
  checkedAt: string | null;
  /**
   * A dialog main wants shown: 'launch' when the launch check finds a newer
   * version, 'manual' for the answer to "Check for Updates…" (up to date,
   * available, or why it failed). Cleared with update:dismiss.
   */
  dialog: 'launch' | 'manual' | null;
  /** The window that shows the dialog (the one that asked, else the focused one); null = any window. */
  dialogWindow: string | null;
}
