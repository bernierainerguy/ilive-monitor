import { useState, type ReactNode } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import { useAppStore } from '../../state/appStore';

const cleanIpcError = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export interface ConfirmState {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void | Promise<void>;
}

/** Required before recall, overwrite and delete. Default focus is Cancel, so Enter never fires a recall by accident. */
export function ConfirmDialog({ state, onClose }: { state: ConfirmState | null; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!state} onClose={() => !busy && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>{state?.title}</DialogTitle>
      <DialogContent>{state?.body}</DialogContent>
      <DialogActions>
        <Button autoFocus onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="contained"
          color={state?.danger ? 'error' : 'primary'}
          disabled={busy}
          onClick={async () => {
            if (!state) return;
            setBusy(true);
            try {
              await state.onConfirm();
            } catch (err) {
              // e.g. a scene overwrite the rack or permissions refused: never let it look like it worked
              useAppStore.getState().notify(`${state.confirmLabel} failed: ${cleanIpcError(err)}`, 'error');
            } finally {
              setBusy(false);
              onClose();
            }
          }}
        >
          {state?.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
