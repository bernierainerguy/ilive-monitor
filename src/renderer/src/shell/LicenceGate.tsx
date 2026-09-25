import { Fragment, useState, type ReactNode } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, TextField, Typography } from '@mui/material';
import { EMAIL_RE, type LicenceRegistration, type LicenceView } from '@shared/licence';
import eulaText from '../../../../legal/WEIM-EULA.md?raw';
import privacyText from '../../../../legal/WEIM-Privacy-Notice.md?raw';
import { useLocation } from 'react-router-dom';
import { invoke } from '../api/bridge';
import { useAppStore } from '../state/appStore';

/**
 * EULA acceptance, first-run registration and the launch gate. The gate is
 * decided by main when the app starts and never closes on a running app, so
 * everything here that blocks can only appear before the operator has started
 * working. While running, problems are reported as dismissible banners.
 */
export const LEGAL_DOCS = { eula: { title: 'Licence agreement', text: eulaText }, privacy: { title: 'Privacy notice', text: privacyText } } as const;
export type LegalDocKey = keyof typeof LEGAL_DOCS;

const setLicence = (licence: LicenceView) => useAppStore.getState().set({ licence });
const notifyError = (e: Error) => useAppStore.getState().notify(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
export const checkInNow = () => invoke('licence:checkin', undefined).then(setLicence, notifyError);

export function LicenceGate() {
  const legal = useAppStore((s) => s.legal);
  const licence = useAppStore((s) => s.licence);
  if (legal && !legal.accepted) return <EulaDialog version={legal.eulaVersion} />;
  if (!legal || !licence || licence.launch.allowed) return null;
  if (licence.reason === 'no-identity') return <RegisterDialog licence={licence} />;
  return <BlockedScreen licence={licence} />;
}

function EulaDialog({ version }: { version: string }) {
  const [busy, setBusy] = useState(false);
  const accept = () => {
    setBusy(true);
    invoke('legal:accept', undefined).then((legal) => useAppStore.getState().set({ legal }), notifyError).finally(() => setBusy(false));
  };
  return (
    <Dialog open maxWidth="md" fullWidth aria-labelledby="eula-title" disableEscapeKeyDown>
      <DialogTitle id="eula-title">Licence agreement</DialogTitle>
      <DialogContent dividers sx={{ maxHeight: '60vh' }}>
        <LegalDoc text={eulaText} />
        <Divider sx={{ my: 2 }} />
        <LegalDoc text={privacyText} />
      </DialogContent>
      <DialogActions>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, pl: 1 }}>Version {version}. Declining quits iLive Monitor.</Typography>
        <Button onClick={() => void invoke('legal:decline', undefined)}>Decline</Button>
        <Button variant="contained" disabled={busy} onClick={accept}>Accept</Button>
      </DialogActions>
    </Dialog>
  );
}

export function IdentityFields({ value, onChange, errors, machineName }: {
  value: LicenceRegistration; onChange(v: LicenceRegistration): void; errors: Partial<Record<keyof LicenceRegistration, string>>; machineName: string;
}) {
  const field = (key: keyof LicenceRegistration, label: string, extra: object = {}) => (
    <TextField label={label} value={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      error={!!errors[key]} helperText={errors[key] ?? ' '} fullWidth size="small" {...extra} />
  );
  return (
    <Stack spacing={1}>
      {field('name', 'Your name', { autoFocus: true, autoComplete: 'name' })}
      {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
      <TextField label="Computer name" value={machineName} disabled fullWidth size="small" helperText="Set by macOS (System Settings → General → About)" />
    </Stack>
  );
}

export function validateIdentity(v: LicenceRegistration): Partial<Record<keyof LicenceRegistration, string>> {
  const e: Partial<Record<keyof LicenceRegistration, string>> = {};
  if (!v.name.trim()) e.name = 'Required';
  if (!EMAIL_RE.test(v.email.trim())) e.email = 'Enter a valid email address';
  return e;
}

/** Store the identity and check in; resolves true when saved. */
export async function register(v: LicenceRegistration): Promise<boolean> {
  try {
    setLicence(await invoke('licence:register', v));
    return true;
  } catch (e) {
    notifyError(e as Error);
    return false;
  }
}

function RegisterDialog({ licence }: { licence: LicenceView }) {
  const [v, setV] = useState<LicenceRegistration>({ name: '', email: '' });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = tried ? validateIdentity(v) : {};
  const submit = async () => {
    setTried(true);
    if (Object.keys(validateIdentity(v)).length) return;
    setBusy(true);
    await register(v);
    setBusy(false);
  };
  return (
    <Dialog open maxWidth="xs" fullWidth aria-labelledby="register-title" disableEscapeKeyDown>
      <form noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <DialogTitle id="register-title">Register iLive Monitor</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            iLive Monitor is free. Tell Whiteley Events who is using it; it checks in once a day and keeps working offline for 30 days.
          </Typography>
          <IdentityFields value={v} onChange={setV} errors={errors} machineName={licence.machineName} />
        </DialogContent>
        <DialogActions>
          <Button type="submit" variant="contained" disabled={busy}>{busy ? 'Registering…' : 'Register'}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function BlockedScreen({ licence }: { licence: LicenceView }) {
  const denied = licence.reason === 'denied';
  return (
    <Dialog open maxWidth="sm" fullWidth aria-labelledby="blocked-title" disableEscapeKeyDown>
      <DialogTitle id="blocked-title">{denied ? 'This installation is not licensed' : 'Licence check-in needed'}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography>
            {denied
              ? 'Whiteley Events has withdrawn the licence for this installation.'
              : 'iLive Monitor hasn’t been able to check in with Whiteley Events for 30 days. Connect this Mac to the internet and retry.'}
          </Typography>
          {denied && licence.deniedReason && <Alert severity="info">{licence.deniedReason}</Alert>}
          {licence.lastError && <Typography variant="body2" color="text.secondary">Last attempt: {licence.lastError}</Typography>}
          <Typography variant="body2" color="text.secondary">
            Questions: hello@whiteleyevents.co.uk{licence.installId ? ` · installation ${licence.installId}` : ''}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" disabled={licence.checking} onClick={() => void checkInNow()}>{licence.checking ? 'Checking…' : 'Retry'}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Non-blocking notices while running. Quiet in show mode. */
export function LicenceBanner() {
  const loc = useLocation();
  const licence = useAppStore((s) => s.licence);
  const dismissed = useAppStore((s) => s.licenceNoticeDismissed);
  const set = useAppStore((s) => s.set);
  // Settings shows the same status in full.
  if (!licence || !licence.launch.allowed || dismissed === licence.reason || loc.pathname === '/settings') return null;
  const close = () => set({ licenceNoticeDismissed: licence.reason });
  const sx = { py: 0, borderRadius: 0 };
  if (licence.reason === 'denied' || licence.reason === 'grace-expired') {
    return (
      <Alert severity="warning" sx={sx} onClose={close}>
        {licence.reason === 'denied' ? 'Whiteley Events has withdrawn this installation’s licence' : 'Licence check-in has lapsed'}
        {licence.deniedReason ? ` (${licence.deniedReason})` : ''}. iLive Monitor keeps running, but won&apos;t start next time until this is resolved.
      </Alert>
    );
  }
  if (licence.reason === 'grace-soon') {
    return (
      <Alert severity="warning" sx={sx} onClose={close} action={<Button size="small" disabled={licence.checking} onClick={() => void checkInNow()}>Check in now</Button>}>
        Licence check-in expires in {licence.graceDaysLeft} day{licence.graceDaysLeft === 1 ? '' : 's'}. Connect to the internet to refresh it.
      </Alert>
    );
  }
  if (licence.reason === 'no-checkin' && licence.lastError && !licence.checking) {
    return (
      <Alert severity="info" sx={sx} onClose={close} action={<Button size="small" onClick={() => void checkInNow()}>Retry</Button>}>
        Registered, but not yet checked in with Whiteley Events. iLive Monitor works normally and will keep trying.
      </Alert>
    );
  }
  return null;
}

// --- the legal documents' Markdown (same dialect as scripts/build-legal-pdfs.py) --------------

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) =>
    part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b>
    : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code>
    : <Fragment key={i}>{part}</Fragment>,
  );
}

export function LegalDoc({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (!bullets.length) return;
    out.push(<Box component="ul" key={`ul${out.length}`} sx={{ my: 0.5, pl: 3 }}>{bullets.map((b, i) => <Typography component="li" variant="body2" key={i}>{inline(b)}</Typography>)}</Box>);
    bullets = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
      continue;
    }
    flush();
    const k = `l${out.length}`;
    if (!line) continue;
    if (line.startsWith('# ')) out.push(<Typography key={k} variant="h6" component="h2">{line.slice(2)}</Typography>);
    else if (line.startsWith('## ')) out.push(<Typography key={k} variant="subtitle1" component="h3" sx={{ mt: 1.5, fontWeight: 600 }}>{line.slice(3)}</Typography>);
    else if (line.startsWith('### ')) out.push(<Typography key={k} variant="subtitle2" component="h4" sx={{ mt: 1 }}>{line.slice(4)}</Typography>);
    else if (line === '---') out.push(<Divider key={k} sx={{ my: 1.5 }} />);
    else out.push(<Typography key={k} variant="body2" sx={{ my: 0.75 }}>{inline(line)}</Typography>);
  }
  flush();
  return <Box>{out}</Box>;
}
