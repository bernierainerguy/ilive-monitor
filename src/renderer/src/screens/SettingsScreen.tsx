import { useEffect, useState } from 'react';
import { Alert, Box, Button, ButtonBase, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import { MIN_PASSWORD_LENGTH, type LockStatus } from '@shared/lock';
import { monitorBuses } from '@shared/monitorPolicy';
import { BUILTIN_THEMES, plateInk } from '@shared/theme';
import { invoke } from '../api/bridge';
import { BUILD } from '../buildInfo';
import { Caption } from '../components/common/Plates';
import { useAppStore } from '../state/appStore';
import { useMixerStore } from '../state/mixerStore';
import { useTokens } from '../theme/ThemeProvider';
import { Licence } from './settings/LicenceSettings';
import { RackSettings } from './settings/RackSettings';
import { updateAction } from '../shell/UpdateUi';

const update = (patch: Parameters<typeof invoke<'settings:update'>>[1]) =>
  invoke('settings:update', patch).then(
    (settings) => useAppStore.getState().set({ settings }),
    (e: Error) => useAppStore.getState().notify(e.message, 'error'),
  );

const message = (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const setLock = (lock: LockStatus) => useAppStore.getState().set({ lock });

/**
 * Settings, behind the Settings password when one is set. Leaving the page locks
 * it again. The main process refuses every Settings change while locked, so this
 * gate isn't the only thing standing in the way.
 */
export default function SettingsScreen() {
  const lock = useAppStore((s) => s.lock);
  // Leaving Settings locks it again.
  useEffect(() => () => void invoke('lock:lock', undefined).then(setLock, () => undefined), []);
  if (!lock) return null;
  if (!lock.unlocked) return <UnlockPanel lock={lock} />;
  return <SettingsPage />;
}

function UnlockPanel({ lock }: { lock: LockStatus }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setLock(await invoke('lock:unlock', { password }));
    } catch (e) {
      setError(message(e as Error));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', p: 3 }}>
      <Stack component="form" spacing={2} sx={{ width: 340 }} onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label="Unlock Settings">
        <Stack direction="row" spacing={1} alignItems="center">
          <LockIcon />
          <Typography variant="h6" component="h2" sx={{ fontWeight: 800 }}>Settings are locked</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">Enter the Settings password to change the mix, the rack or anything else here.</Typography>
        <TextField
          autoFocus
          type="password"
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={!!error}
          helperText={error ?? (lock.retryAt ? 'Too many wrong passwords: wait a moment.' : ' ')}
          inputProps={{ 'aria-label': 'Password' }}
        />
        <Button type="submit" variant="contained" disabled={busy || !password}>Unlock</Button>
        <Typography variant="caption" color="text.secondary">
          Forgotten it? Quit iLive Monitor, delete settings-lock.json from ~/Library/Application Support/iLive Monitor, and reopen.
          That removes the password and nothing else.
        </Typography>
      </Stack>
    </Box>
  );
}

type Section = 'mix' | 'rack' | 'password' | 'appearance' | 'licence' | 'about';
const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: 'mix', label: 'Mix bus' },
  { id: 'rack', label: 'Rack' },
  { id: 'password', label: 'Password' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'licence', label: 'Licence' },
  { id: 'about', label: 'About' },
];

/**
 * The mix bus this Mac adjusts, the rack, password, appearance, licence and version. All kept between launches.
 * A sidebar shows one section at a time, so nothing hides below the fold.
 */
function SettingsPage() {
  const t = useTokens();
  const [section, setSection] = useState<Section>('mix');
  return (
    <Box sx={{ height: '100%', display: 'flex', minHeight: 0 }}>
      <Box
        role="tablist"
        aria-label="Settings"
        aria-orientation="vertical"
        sx={{ width: 190, flexShrink: 0, p: 1.5, display: 'flex', flexDirection: 'column', gap: '4px', borderRight: `1px solid ${t.colours.border}`, bgcolor: t.colours.surface }}
      >
        {SECTIONS.map((x) => {
          const on = x.id === section;
          return (
            <ButtonBase
              key={x.id}
              role="tab"
              aria-selected={on}
              onClick={() => setSection(x.id)}
              sx={{
                justifyContent: 'flex-start', height: 40, px: 1.5, borderRadius: '8px', fontSize: 14, fontWeight: 700,
                color: on ? plateInk(t.colours.accent, t) : t.colours.textMuted, bgcolor: on ? t.colours.accent : 'transparent',
                '&:hover': { color: on ? plateInk(t.colours.accent, t) : t.colours.text, bgcolor: on ? t.colours.accent : t.colours.surfaceRaised },
              }}
            >
              {x.label}
            </ButtonBase>
          );
        })}
      </Box>
      {/* Every section stays mounted (only one shows), so a half-typed rack or password survives a look elsewhere. */}
      {SECTIONS.map((x) => (
        <Box key={x.id} role="tabpanel" aria-label={x.label} hidden={x.id !== section} sx={{ flex: 1, minWidth: 0, overflow: 'auto', p: 2.5 }}>
          <Box sx={{ maxWidth: 1100 }}>
            <Caption>{x.label}</Caption>
            {x.id === 'mix' && <BusPicker />}
            {x.id === 'rack' && <RackSettings />}
            {x.id === 'password' && <PasswordSection />}
            {x.id === 'appearance' && <Appearance />}
            {x.id === 'licence' && <Licence />}
            {x.id === 'about' && (
              <>
                <Typography variant="body2" sx={{ fontFamily: t.fonts.mono }}>iLive Monitor {BUILD.version} ({BUILD.commit})</Typography>
                <UpdateSection />
              </>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function Appearance() {
  const themeId = useAppStore((s) => s.settings?.themeId ?? 'dark');
  return (
    <ToggleButtonGroup size="small" exclusive value={themeId} onChange={(_, v) => v && void update({ themeId: v })} aria-label="Theme">
      {BUILTIN_THEMES.map((th) => <ToggleButton key={th.id} value={th.id}>{th.name}</ToggleButton>)}
    </ToggleButtonGroup>
  );
}

/** Pick the aux whose sends this Mac adjusts. Saved at once, and the app opens on it every time. */
function BusPicker() {
  const t = useTokens();
  const aux = useAppStore((s) => s.settings?.aux ?? null);
  const live = useAppStore((s) => s.rack.phase === 'online' || s.rack.phase === 'degraded');
  const state = useMixerStore((s) => s.state);
  if (!state) return null;
  const auxes = monitorBuses(state);
  return (
    <Stack spacing={1.25}>
      <Typography variant="body2" color="text.secondary">
        The aux whose sends the faders adjust. iLive Monitor opens on it at every launch, and can&apos;t change any other mix.
        {!live && ' Connect to the rack to see its auxes with their names and in the rack’s layout.'}
      </Typography>
      {auxes.length === 0 ? (
        <Typography variant="body2">This rack has no auxes. Check its mix configuration under Rack.</Typography>
      ) : (
        <Box role="radiogroup" aria-label="Mix bus" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 112px)', gap: '8px' }}>
          {auxes.map((m, i) => {
            const n = i + 1;
            const on = n === aux;
            const c = m.colour !== 'off' ? t.strip[m.colour] : t.colours.border;
            return (
              <ButtonBase
                key={m.ref.index}
                role="radio"
                aria-checked={on}
                aria-label={`Aux ${n} ${m.name}`}
                onClick={() => void update({ aux: n })}
                sx={{
                  height: 58, borderRadius: '7px', flexDirection: 'column', gap: '2px',
                  color: on ? plateInk(t.colours.sofActive, t) : t.colours.text, bgcolor: on ? t.colours.sofActive : t.colours.surface,
                  borderTop: `4px solid ${c}`, boxShadow: `inset 0 0 0 1px ${on ? t.colours.sofActive : t.colours.border}`,
                }}
              >
                <Typography component="span" sx={{ fontSize: 10, fontWeight: 700, opacity: 0.8 }}>Aux {n}{m.stereo ? ' · ST' : ''}</Typography>
                <Typography component="span" noWrap sx={{ fontSize: 14, fontWeight: 800, maxWidth: 100 }}>{m.name}</Typography>
              </ButtonBase>
            );
          })}
        </Box>
      )}
    </Stack>
  );
}

function UpdateSection() {
  const u = useAppStore((s) => s.update);
  const line = !u
    ? 'Update status unknown.'
    : u.status === 'checking' ? 'Checking…'
    : u.checkError ? `Couldn't check: ${u.checkError}`
    : u.status === 'available' ? `Version ${u.available?.version} is available.`
    : u.status === 'downloading' ? `Downloading ${u.available?.version}… ${u.progress ?? 0}%`
    : u.status === 'downloaded' ? `Downloaded ${u.available?.version} to your Downloads folder.`
    : u.status === 'up-to-date' ? `Up to date${u.checkedAt ? ` (checked ${new Date(u.checkedAt).toLocaleTimeString()})` : ''}.`
    : u.status === 'error' ? `Download of ${u.available?.version ?? 'the update'} failed: ${u.error}`
    : 'Updates are checked automatically.';
  return (
    <Stack spacing={1} sx={{ pt: 1.5 }}>
      <Typography variant="body2" color="text.secondary">{line}</Typography>
      <Stack direction="row" spacing={1}>
        <Button size="small" variant="outlined" disabled={u?.status === 'checking' || u?.status === 'downloading'} onClick={() => void updateAction('update:check')}>
          Check for updates
        </Button>
        {u?.available && (
          <Button size="small" variant="contained" onClick={() => useAppStore.getState().set({ updateDialogOpen: true })}>
            Update to {u.available.version}…
          </Button>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary">Also in the iLive Monitor menu: Check for Updates…</Typography>
    </Stack>
  );
}

/** Set, change or remove the Settings password. Settings is unlocked to get here. */
function PasswordSection() {
  const has = useAppStore((s) => s.lock?.hasPassword ?? false);
  const notify = useAppStore((s) => s.notify);
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const tooShort = next.length < MIN_PASSWORD_LENGTH;
  const mismatch = next !== again;
  const save = async (password: string | null) => {
    setTried(true);
    if (password !== null && (tooShort || mismatch)) return;
    try {
      setLock(await invoke('lock:setPassword', { password }));
      notify(password === null ? 'Password removed: Settings are open to anyone' : has ? 'Password changed' : 'Password set: Settings lock when you leave them', 'success');
      setNext('');
      setAgain('');
      setTried(false);
    } catch (e) {
      notify(message(e as Error), 'error');
    }
  };
  return (
    <Stack spacing={1.5} sx={{ maxWidth: 420 }}>
      <Typography variant="body2" color="text.secondary">
        {has
          ? 'Settings are password protected. They lock again when you leave this page, and after 10 minutes here.'
          : 'Anyone can open Settings and change the mix or the rack. Set a password so only you can.'}
      </Typography>
      <Stack component="form" direction="row" spacing={1} alignItems="flex-start" onSubmit={(e) => { e.preventDefault(); void save(next); }}>
        <TextField size="small" type="password" label={has ? 'New password' : 'Password'} value={next} onChange={(e) => setNext(e.target.value)}
          error={tried && tooShort} helperText={tried && tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters` : ' '} inputProps={{ 'aria-label': has ? 'New password' : 'Password' }} />
        <TextField size="small" type="password" label="Again" value={again} onChange={(e) => setAgain(e.target.value)}
          error={tried && !tooShort && mismatch} helperText={tried && !tooShort && mismatch ? 'Doesn’t match' : ' '} inputProps={{ 'aria-label': 'Password again' }} />
        <Button type="submit" variant="contained" sx={{ mt: '2px' }}>{has ? 'Change' : 'Set password'}</Button>
      </Stack>
      {has && (
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" onClick={() => void invoke('lock:lock', undefined).then(setLock)}>Lock now</Button>
          <Button size="small" color="error" onClick={() => void save(null)}>Remove password</Button>
        </Stack>
      )}
      {has && <Alert severity="info" sx={{ py: 0 }}>Forgotten it? Delete settings-lock.json from ~/Library/Application Support/iLive Monitor while the app is closed.</Alert>}
    </Stack>
  );
}
