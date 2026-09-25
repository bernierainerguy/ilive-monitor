import { useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import type { LicenceRegistration, LicenceView } from '@shared/licence';
import { IdentityFields, LEGAL_DOCS, LegalDoc, checkInNow, register, validateIdentity, type LegalDocKey } from '../../shell/LicenceGate';
import { useAppStore } from '../../state/appStore';
import { useTokens } from '../../theme/ThemeProvider';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function statusLine(l: LicenceView): { text: string; severity: 'success' | 'info' | 'warning' | 'error' } {
  switch (l.reason) {
    case 'granted': return { text: `Licensed. Check-in valid for ${l.graceDaysLeft} more days.`, severity: 'success' };
    case 'grace-soon': return { text: `Check-in expires in ${l.graceDaysLeft} day${l.graceDaysLeft === 1 ? '' : 's'}. Connect to the internet and check in.`, severity: 'warning' };
    case 'no-checkin': return { text: 'Registered, not yet checked in. iLive Monitor works normally meanwhile.', severity: 'info' };
    case 'denied': return { text: `Licence withdrawn${l.deniedReason ? `: ${l.deniedReason}` : ''}. This session keeps running; iLive Monitor won't start next time.`, severity: 'error' };
    case 'grace-expired': return { text: 'Check-in lapsed. This session keeps running; iLive Monitor needs to check in before it starts next time.', severity: 'error' };
    default: return { text: 'Not registered.', severity: 'info' };
  }
}

/** Settings → Licence: registration details, check-in status, and the legal documents. */
export function Licence() {
  const t = useTokens();
  const l = useAppStore((s) => s.licence);
  const legal = useAppStore((s) => s.legal);
  const [editing, setEditing] = useState(false);
  const [doc, setDoc] = useState<LegalDocKey | null>(null);
  if (!l) return null;
  const s = statusLine(l);
  const rows: Array<[string, string]> = [
    ['Name', l.identity?.name ?? '—'],
    ['Email', l.identity?.email ?? '—'],
    ['Computer', l.identity?.machineName || '—'],
    ['Installation', l.installId ?? '—'],
    ['Last check-in', when(l.lastCheckinAt)],
    ['Valid until', when(l.graceUntil)],
    ...(l.lastError ? ([['Last error', l.lastError]] as Array<[string, string]>) : []),
    ['Agreement', legal?.accepted ? `Version ${legal.eulaVersion}, accepted ${when(legal.acceptedAt)}` : '—'],
  ];
  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Alert severity={s.severity} data-testid="licence-status">{s.text}</Alert>
      <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 0.75, m: 0 }}>
        {rows.map(([k, v]) => (
          <Box key={k} sx={{ display: 'contents' }}>
            <Typography component="dt" variant="body2" color="text.secondary">{k}</Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, fontFamily: k === 'Installation' ? t.fonts.mono : undefined, overflowWrap: 'anywhere' }}>{v}</Typography>
          </Box>
        ))}
      </Box>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button size="small" variant="outlined" disabled={l.checking || !l.identity} onClick={() => void checkInNow()}>{l.checking ? 'Checking…' : 'Check in now'}</Button>
        <Button size="small" variant="outlined" onClick={() => setEditing(true)}>Change details</Button>
        <Button size="small" onClick={() => setDoc('eula')}>Licence agreement</Button>
        <Button size="small" onClick={() => setDoc('privacy')}>Privacy notice</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        iLive Monitor checks in with whiteleyevents.co.uk when it starts and once a day, and runs offline for 30 days after the last check-in.
        A licence problem never stops a running session.
      </Typography>
      {editing && <EditIdentity l={l} onClose={() => setEditing(false)} />}
      {doc && (
        <Dialog open onClose={() => setDoc(null)} maxWidth="md" fullWidth PaperProps={{ 'aria-label': LEGAL_DOCS[doc].title }}>
          <DialogContent dividers sx={{ maxHeight: '70vh' }}><LegalDoc text={LEGAL_DOCS[doc].text} /></DialogContent>
          <DialogActions><Button onClick={() => setDoc(null)}>Close</Button></DialogActions>
        </Dialog>
      )}
    </Stack>
  );
}

function EditIdentity({ l, onClose }: { l: LicenceView; onClose(): void }) {
  const [v, setV] = useState<LicenceRegistration>({ name: l.identity?.name ?? '', email: l.identity?.email ?? '' });
  const [tried, setTried] = useState(false);
  const errors = tried ? validateIdentity(v) : {};
  const save = async () => {
    setTried(true);
    if (Object.keys(validateIdentity(v)).length) return;
    if (await register(v)) onClose();
  };
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="edit-licence-title">
      <form noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <DialogTitle id="edit-licence-title">Registration details</DialogTitle>
        <DialogContent><Box sx={{ pt: 1 }}><IdentityFields value={v} onChange={setV} errors={errors} machineName={l.machineName} /></Box></DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained">Save and check in</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
