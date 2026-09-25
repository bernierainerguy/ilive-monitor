import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Box, Button, ButtonBase, Chip, Snackbar, Typography } from '@mui/material';
import TuneIcon from '@mui/icons-material/Tune';
import SettingsIcon from '@mui/icons-material/Settings';
import LockIcon from '@mui/icons-material/Lock';
import { plateInk } from '@shared/theme';
import { useAppStore } from '../state/appStore';
import { useTokens } from '../theme/ThemeProvider';
import { LicenceBanner, LicenceGate } from './LicenceGate';
import { UpdateDialog, UpdatePill } from './UpdateUi';

const PHASE_COLOUR = { offline: 'default', connecting: 'info', syncing: 'info', online: 'success', degraded: 'warning', reconnecting: 'error' } as const;

export const formatLatency = (ms: number) => (ms < 1 ? '<1 ms' : `${Math.round(ms)} ms`);

/** Title bar (two views: the faders and Settings), status banners, dialogs and toasts. */
export function Shell({ children }: { children: ReactNode }) {
  const t = useTokens();
  const toast = useAppStore((s) => s.toast);
  const set = useAppStore((s) => s.set);
  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: t.colours.background, color: t.colours.text, userSelect: 'none' }}>
      <Box
        sx={{
          height: 50, display: 'flex', alignItems: 'center', gap: 1, pl: 10, pr: 1, borderBottom: `1px solid ${t.colours.border}`,
          bgcolor: t.colours.surface, boxShadow: '0 1px 0 rgba(0,0,0,.35)',
          WebkitAppRegion: 'drag', '& button, & input, & .MuiChip-root': { WebkitAppRegion: 'no-drag' },
        }}
      >
        <Typography sx={{ fontWeight: 800, fontSize: 14, mr: 1, whiteSpace: 'nowrap' }}>iLive Monitor</Typography>
        <Box component="nav" aria-label="Views" sx={{ display: 'flex', gap: 1 }}>
          <NavKey path="/mix" label="Mix" icon={<TuneIcon sx={{ fontSize: 18 }} />} />
          <SettingsKey />
        </Box>
        <Box sx={{ flex: 1 }} />
        <UpdatePill />
        <RackChip />
      </Box>
      <LicenceBanner />
      <StatusBanner />
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{children}</Box>
      <UpdateDialog />
      <LicenceGate />
      <Snackbar open={!!toast} autoHideDuration={3500} onClose={() => set({ toast: null })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {toast ? <Alert severity={toast.severity} variant="filled" onClose={() => set({ toast: null })}>{toast.message}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}

/** Settings, with a padlock while a password keeps it locked. */
function SettingsKey() {
  const locked = useAppStore((s) => !!s.lock && !s.lock.unlocked);
  return <NavKey path="/settings" label="Settings" icon={locked ? <LockIcon aria-label="locked" sx={{ fontSize: 18 }} /> : <SettingsIcon sx={{ fontSize: 18 }} />} />;
}

function NavKey({ path, label, icon }: { path: string; label: string; icon: ReactNode }) {
  const t = useTokens();
  const nav = useNavigate();
  const on = useLocation().pathname === path;
  return (
    <ButtonBase
      aria-label={label}
      aria-current={on ? 'page' : undefined}
      onClick={() => nav(path)}
      sx={{
        height: 34, px: 1.5, gap: 0.75, borderRadius: '8px', fontSize: 13, fontWeight: 700,
        color: on ? plateInk(t.colours.accent, t) : t.colours.textMuted, bgcolor: on ? t.colours.accent : 'transparent',
        '&:hover': { color: on ? plateInk(t.colours.accent, t) : t.colours.text },
      }}
    >
      {icon}
      {label}
    </ButtonBase>
  );
}

function RackChip() {
  const rack = useAppStore((s) => s.rack);
  const nav = useNavigate();
  const name = rack.identity?.name ?? 'Offline';
  const live = rack.phase === 'online' || rack.phase === 'degraded';
  const latency = live && rack.health.rttMs !== null ? formatLatency(rack.health.rttMs) : null;
  const status = [rack.phase, latency].filter(Boolean).join(' · ');
  return (
    <Chip
      size="small"
      color={PHASE_COLOUR[rack.phase]}
      onClick={() => nav('/settings')}
      aria-label={`Rack: ${name}, ${status}`}
      sx={{ flexShrink: 0, maxWidth: 280 }}
      label={`${name} · ${status}`}
    />
  );
}

/** Why the faders are locked, or why some levels are guesses. Always says what to do. */
function StatusBanner() {
  const rack = useAppStore((s) => s.rack);
  const nav = useNavigate();
  const onSettings = useLocation().pathname === '/settings';
  const live = rack.phase === 'online' || rack.phase === 'degraded';
  const go = onSettings ? undefined : <Button color="inherit" size="small" onClick={() => nav('/settings')}>Settings</Button>;
  const sx = { py: 0, borderRadius: 0 };
  if (rack.phase === 'reconnecting') {
    return <Alert severity="error" sx={sx}>Not connected to the rack{rack.lastError ? `: ${rack.lastError}` : ''}. Retrying every 2 seconds; the faders are locked until it connects.</Alert>;
  }
  if (!live) {
    if (rack.phase === 'offline') return <Alert severity="info" sx={sx} action={go}>Not connected to a rack. The faders are locked until you connect in Settings.</Alert>;
    return null; // connecting / syncing: brief, and the chip says so
  }
  if (!rack.capabilities.sends) {
    return <Alert severity="warning" sx={sx} action={go}>Enter the rack’s mix configuration in Settings. Without it, sends can’t reach the right bus, so the faders are locked.</Alert>;
  }
  if (rack.unconfirmed.length) {
    const n = rack.unconfirmed.length;
    return (
      <Alert severity="info" sx={sx}>
        {n} send level{n === 1 ? '' : 's'} not known yet (ghosted, level “?”). The rack can’t report send levels over MIDI, so each one appears when it’s moved here or on the console.
      </Alert>
    );
  }
  return null;
}
