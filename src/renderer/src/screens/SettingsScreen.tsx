import { Box, Button, ButtonBase, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { monitorBuses } from '@shared/monitorPolicy';
import { BUILTIN_THEMES, plateInk } from '@shared/theme';
import { invoke } from '../api/bridge';
import { BUILD } from '../buildInfo';
import { Caption } from '../components/common/Plates';
import { busLabel } from '../services/labels';
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

/** The mix bus this Mac adjusts, the rack, appearance, licence and version. All kept between launches. */
export default function SettingsScreen() {
  const t = useTokens();
  const themeId = useAppStore((s) => s.settings?.themeId ?? 'dark');
  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 2.5 }}>
      <Stack spacing={4} sx={{ maxWidth: 1100 }}>
        <Box component="section" aria-label="Mix bus">
          <Caption>Mix bus</Caption>
          <BusPicker />
        </Box>
        <Box component="section" aria-label="Rack">
          <Caption>Rack</Caption>
          <RackSettings />
        </Box>
        <Box component="section" aria-label="Appearance">
          <Caption>Appearance</Caption>
          <ToggleButtonGroup size="small" exclusive value={themeId} onChange={(_, v) => v && void update({ themeId: v })} aria-label="Theme">
            {BUILTIN_THEMES.map((th) => <ToggleButton key={th.id} value={th.id}>{th.name}</ToggleButton>)}
          </ToggleButtonGroup>
        </Box>
        <Box component="section" aria-label="Licence">
          <Caption>Licence</Caption>
          <Licence />
        </Box>
        <Box component="section" aria-label="About">
          <Caption>About</Caption>
          <Typography variant="body2" sx={{ fontFamily: t.fonts.mono }}>iLive Monitor {BUILD.version} ({BUILD.commit})</Typography>
          <UpdateSection />
        </Box>
      </Stack>
    </Box>
  );
}

/** Pick the aux whose sends this Mac adjusts. Saved at once, and the app opens on it every time. */
function BusPicker() {
  const t = useTokens();
  const bus = useAppStore((s) => s.settings?.bus ?? null);
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
        <Typography variant="body2">This rack has no auxes. Check the mix configuration below.</Typography>
      ) : (
        <Box role="radiogroup" aria-label="Mix bus" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 112px)', gap: '8px' }}>
          {auxes.map((m) => {
            const on = m.ref.index === bus;
            const c = m.colour !== 'off' ? t.strip[m.colour] : t.colours.border;
            return (
              <ButtonBase
                key={m.ref.index}
                role="radio"
                aria-checked={on}
                aria-label={`${busLabel(state, m.ref.index)} ${m.name}`}
                onClick={() => void update({ bus: m.ref.index })}
                sx={{
                  height: 58, borderRadius: '7px', flexDirection: 'column', gap: '2px',
                  color: on ? plateInk(t.colours.sofActive, t) : t.colours.text, bgcolor: on ? t.colours.sofActive : t.colours.surface,
                  borderTop: `4px solid ${c}`, boxShadow: `inset 0 0 0 1px ${on ? t.colours.sofActive : t.colours.border}`,
                }}
              >
                <Typography component="span" sx={{ fontSize: 10, fontWeight: 700, opacity: 0.8 }}>{busLabel(state, m.ref.index)}{m.stereo ? ' · ST' : ''}</Typography>
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
