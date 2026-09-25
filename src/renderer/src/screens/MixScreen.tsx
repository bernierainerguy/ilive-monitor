import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, ButtonBase, Stack, Typography } from '@mui/material';
import type { StripRef } from '@shared/domain/ids';
import { isMonitorBus } from '@shared/monitorPolicy';
import { plateInk } from '@shared/theme';
import { SendStrip, STRIP_CHROME } from '../components/strip/SendStrip';
import { busLabel } from '../services/labels';
import { useAppStore } from '../state/appStore';
import { useMixerStore } from '../state/mixerStore';
import { useTokens } from '../theme/ThemeProvider';

type Bank = 'in1' | 'in2' | 'fx';
const BANKS: ReadonlyArray<{ id: Bank; label: string }> = [
  { id: 'in1', label: 'Inputs 1–32' },
  { id: 'in2', label: 'Inputs 33–64' },
  { id: 'fx', label: 'FX returns' },
];

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
function bankStrips(bank: Bank, fxReturns: number): StripRef[] {
  if (bank === 'fx') return range(0, fxReturns).map((index) => ({ kind: 'fxReturn', index }));
  return (bank === 'in1' ? range(0, 32) : range(32, 64)).map((index) => ({ kind: 'input', index }));
}

/**
 * The whole job of iLive Monitor: every input and FX return's send level to the
 * one bus chosen in Settings, on faders. The bus can't be changed here.
 */
export default function MixScreen() {
  const t = useTokens();
  const nav = useNavigate();
  const bus = useAppStore((s) => s.settings?.bus ?? null);
  const rack = useAppStore((s) => s.rack);
  // Subscribe to the bus strip and the shape of the mixes only, never to levels.
  const busStrip = useMixerStore((s) => (s.state && bus !== null ? s.state.mixes[bus] : undefined));
  const valid = useMixerStore((s) => (s.state ? isMonitorBus(s.state, bus) : false));
  const label = useMixerStore((s) => (s.state && bus !== null && valid ? busLabel(s.state, bus) : ''));
  const fxReturns = useMixerStore((s) => s.state?.fxReturns.length ?? 0);
  const [bank, setBank] = useState<Bank>('in1');
  const strips = useMemo(() => bankStrips(bank, fxReturns), [bank, fxReturns]);

  const well = useRef<HTMLDivElement>(null);
  const [faderHeight, setFaderHeight] = useState(300);
  useEffect(() => {
    const el = well.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setFaderHeight(Math.max(180, Math.floor(e.contentRect.height - STRIP_CHROME - 8))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [valid]);

  if (bus === null || !valid || !busStrip) {
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', p: 3 }}>
        <Stack spacing={1.5} alignItems="center" sx={{ maxWidth: 460, textAlign: 'center' }}>
          <Typography variant="h6" sx={{ fontWeight: 800 }}>{bus === null ? 'Choose your mix' : 'Your mix isn’t an aux on this rack'}</Typography>
          <Typography color="text.secondary">
            {bus === null
              ? 'Pick the aux this Mac mixes in Settings. iLive Monitor opens on it every time.'
              : 'The rack’s mix configuration has changed since the mix was chosen. Choose it again in Settings.'}
          </Typography>
          <Button variant="contained" onClick={() => nav('/settings')}>Open Settings</Button>
        </Stack>
      </Box>
    );
  }

  const live = rack.phase === 'online' || rack.phase === 'degraded';
  const enabled = live && rack.capabilities.sends;
  const colour = busStrip.colour !== 'off' ? t.strip[busStrip.colour] : t.colours.sofActive;

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 1, borderBottom: `1px solid ${t.colours.border}` }}>
        <Box
          aria-label={`Mix: ${label} ${busStrip.name}`}
          sx={{
            display: 'flex', alignItems: 'baseline', gap: 1, px: 1.5, height: 38, borderRadius: '7px', flexShrink: 0,
            bgcolor: colour, color: plateInk(colour, t), boxShadow: 'inset 0 1px 0 rgba(255,255,255,.3), inset 0 -2px 0 rgba(0,0,0,.25)', lineHeight: '38px',
          }}
        >
          <Typography component="span" sx={{ fontSize: 12, fontWeight: 700, opacity: 0.8 }}>{label}</Typography>
          <Typography component="span" sx={{ fontSize: 18, fontWeight: 800 }}>{busStrip.name}</Typography>
          {busStrip.stereo && <Typography component="span" sx={{ fontSize: 11, fontWeight: 700, opacity: 0.8 }}>ST</Typography>}
        </Box>
        <Box role="group" aria-label="Channels" sx={{ display: 'flex', p: '3px', gap: '2px', borderRadius: '9px', bgcolor: t.colours.faderTrack, boxShadow: `inset 0 0 0 1px ${t.colours.border}` }}>
          {BANKS.map((b) => {
            const on = b.id === bank;
            return (
              <ButtonBase
                key={b.id}
                aria-pressed={on}
                onClick={() => setBank(b.id)}
                sx={{
                  height: 32, px: 1.75, borderRadius: '6px', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
                  color: on ? plateInk(t.colours.accent, t) : t.colours.textMuted, bgcolor: on ? t.colours.accent : 'transparent',
                }}
              >
                {b.label}
              </ButtonBase>
            );
          })}
        </Box>
      </Box>
      <Box
        ref={well}
        data-testid="send-bank"
        sx={{
          flex: 1, minHeight: 0, display: 'flex', overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain', py: '4px', pl: '2px',
          borderTop: `3px solid ${colour}`, maskImage: 'linear-gradient(to right, #000 calc(100% - 48px), transparent)',
        }}
      >
        {strips.map((ref) => (
          <SendStrip key={`${ref.kind}:${ref.index}`} strip={ref} bus={bus} faderHeight={faderHeight} accent={colour} enabled={enabled} />
        ))}
      </Box>
    </Box>
  );
}
