import { Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Typography } from '@mui/material';
import type { InvokeChannel } from '@shared/ipc';
import type { UpdateState } from '@shared/update';
import { invoke, windowId } from '../api/bridge';
import { useAppStore } from '../state/appStore';

/**
 * Update UI, modelled on WESC (~/Developer/wesc-update-checks.md): a quiet pill
 * in the top bar while an update is waiting, and one dialog for the launch
 * prompt, "Check for Updates…" answers, and the Open installer / Show in Finder
 * / Later choice after a download. Nothing appears in show mode.
 */
type UpdateAction = Extract<InvokeChannel, 'update:check' | 'update:download' | 'update:openInstaller' | 'update:reveal' | 'update:openPage' | 'update:dismiss'>;

export const updateAction = (channel: UpdateAction) =>
  invoke(channel, undefined).then(
    (update) => useAppStore.getState().set({ update }),
    (e: Error) => useAppStore.getState().notify(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'),
  );

const close = () => {
  useAppStore.getState().set({ updateDialogOpen: false });
  void updateAction('update:dismiss');
};

export function UpdatePill() {
  const u = useAppStore((s) => s.update);
  const set = useAppStore((s) => s.set);
  if (!u?.available) return null;
  const v = u.available.version;
  const label = u.status === 'downloading' ? `↓ v${v} ${u.progress ?? 0}%` : u.status === 'downloaded' ? `v${v} downloaded` : `↑ v${v} available`;
  return (
    <Chip size="small" color="info" label={label} onClick={() => set({ updateDialogOpen: true })}
      aria-label={`Update: ${label}`} sx={{ flexShrink: 0, fontWeight: 600 }} />
  );
}

export function UpdateDialog() {
  const u = useAppStore((s) => s.update);
  const open = useAppStore((s) => s.updateDialogOpen);
  // Only in the window main chose (the one that asked, else the focused one), not every open window.
  const mine = !!u && (u.dialogWindow === null || u.dialogWindow === windowId());
  // The launch prompt waits out show mode; an answer the operator asked for always shows.
  if (!u || !(open || (mine && (u.dialog === 'manual' || (u.dialog === 'launch'))))) return null;
  const body = content(u);
  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth aria-labelledby="update-title">
      <DialogTitle id="update-title">{body.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {body.text && <Typography variant="body2">{body.text}</Typography>}
          {body.progress !== undefined && <LinearProgress variant={body.progress === null ? 'indeterminate' : 'determinate'} value={body.progress ?? 0} />}
          {body.busy && <Box sx={{ display: 'grid', placeItems: 'center', py: 1 }}><CircularProgress size={28} /></Box>}
        </Stack>
      </DialogContent>
      <DialogActions>{body.actions}</DialogActions>
    </Dialog>
  );
}

function content(u: UpdateState): { title: string; text?: string; progress?: number | null; busy?: boolean; actions: JSX.Element } {
  const v = u.available?.version;
  const later = <Button onClick={close}>Later</Button>;
  const ok = <Button variant="contained" onClick={close}>OK</Button>;
  if (u.checkError && u.status !== 'checking' && u.dialog === 'manual') {
    return {
      title: 'Couldn’t check for updates',
      text: `${u.checkError}${v ? ` iLive Monitor ${v} was found earlier and is still available.` : ''}`,
      actions: v && u.status === 'available' ? <>{later}<Button variant="contained" onClick={() => useAppStore.getState().set({ update: { ...u, checkError: null } })}>Show {v}</Button></> : ok,
    };
  }
  switch (u.status) {
    case 'checking':
      return { title: 'Checking for updates…', busy: true, actions: <Button onClick={close}>Hide</Button> };
    case 'available':
      return {
        title: `iLive Monitor ${v} is available`,
        text: u.available?.url
          ? `You have ${u.current}. It downloads to your Downloads folder; you install it yourself when it suits — nothing changes until you do.`
          : `You have ${u.current}. Get it from the Whiteley Events website.`,
        actions: <>{later}{u.available?.url
          ? <Button variant="contained" onClick={() => void updateAction('update:download')}>Download</Button>
          : <Button variant="contained" onClick={() => void updateAction('update:openPage').then(close)}>Open download page</Button>}</>,
      };
    case 'downloading':
      return { title: `Downloading iLive Monitor ${v}`, text: `${u.progress ?? 0}%`, progress: u.progress, actions: <Button onClick={close}>Hide</Button> };
    case 'downloaded':
      return {
        title: `iLive Monitor ${v} is ready`,
        text: 'Saved to your Downloads folder and checked as signed by Whiteley Events. Open it, drag iLive Monitor to Applications, then quit and reopen iLive Monitor.',
        actions: <>{later}
          <Button onClick={() => void updateAction('update:reveal')}>Show in Finder</Button>
          <Button variant="contained" onClick={() => void updateAction('update:openInstaller').then(close)}>Open installer</Button></>,
      };
    case 'error':
      return {
        title: 'Download failed',
        text: `${u.error ?? 'The download did not complete.'} You can get iLive Monitor ${v ?? ''} from the website instead.`,
        actions: <><Button onClick={close}>Close</Button><Button variant="contained" onClick={() => void updateAction('update:openPage').then(close)}>Open download page</Button></>,
      };
    case 'up-to-date':
      return { title: 'You’re up to date', text: `iLive Monitor ${u.current} is the latest version.`, actions: ok };
    default:
      return { title: 'Updates', text: u.checkError ?? 'Updates are checked automatically, except in show mode.', actions: ok };
  }
}
