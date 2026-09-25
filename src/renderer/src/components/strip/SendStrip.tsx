import { memo, useCallback, useState } from 'react';
import { Box, Typography } from '@mui/material';
import type { StripRef } from '@shared/domain/ids';
import { defaultSend } from '@shared/domain/defaults';
import type { InputStrip } from '@shared/domain/model';
import { FADER_MAX_DB, FADER_MIN_DB, formatDb } from '@shared/domain/units';
import { plateInk } from '@shared/theme';
import { unconfirmedSendKey } from '@shared/rack';
import { dispatch } from '../../services/mixer';
import { sourceLabel } from '../../services/labels';
import { useAppStore } from '../../state/appStore';
import { useStrip } from '../../state/mixerStore';
import { useTokens } from '../../theme/ThemeProvider';
import { Fader } from '../fader/Fader';

export interface SendStripProps {
  strip: StripRef;
  /** The mix bus from Settings. */
  bus: number;
  faderHeight: number;
  /** The bus's colour, for the fader cap. */
  accent: string;
  /** False while the rack can't take the move (offline, no mix configuration). */
  enabled: boolean;
}

/**
 * One input's send to the bus: its lit name plate, the send-level fader and the
 * level. That's all: no mute, pan, PAFL or processing, by design.
 */
export const SendStrip = memo(function SendStrip({ strip, bus, faderHeight, accent, enabled }: SendStripProps) {
  const t = useTokens();
  const s = useStrip(strip);
  // MIDI can't report send levels: until the rack reports this one or it's moved here, it's a guess.
  const unconfirmed = useAppStore((x) => x.rack.unconfirmed.length > 0 && x.rack.unconfirmed.includes(unconfirmedSendKey(strip, bus)));
  const onLevel = useCallback((db: number) => void dispatch({ t: 'send', strip, target: { kind: 'mix', index: bus }, patch: { levelDb: db } }), [strip, bus]);

  if (!s || !('sends' in s)) return null;
  const level = ((s as InputStrip).sends[bus] ?? defaultSend()).levelDb;
  const lit = s.colour !== 'off';
  const colour = t.strip[s.colour];
  const label = sourceLabel(strip);

  return (
    <Box
      data-testid={`send-${strip.kind}:${strip.index}`}
      sx={{
        // Strips share the bank's width evenly: no scrolling, and wider strips on a big screen.
        flex: '1 1 0', minWidth: 0, maxWidth: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${GAP}px`,
        p: `${PAD}px 5px`, mx: '2px', boxSizing: 'border-box', borderRadius: '8px', bgcolor: t.colours.surface, border: `1px solid ${t.colours.border}`,
      }}
    >
      <Box
        sx={{
          width: '100%', height: PLATE_H, flexShrink: 0, borderRadius: '5px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
          bgcolor: lit ? colour : t.colours.surfaceRaised, color: lit ? plateInk(colour, t) : t.colours.text,
          boxShadow: lit ? `inset 0 1px 0 rgba(255,255,255,.35), inset 0 -2px 0 rgba(0,0,0,.25), 0 0 0 1px ${t.mode === 'light' ? t.colours.border : 'transparent'}` : `inset 0 0 0 1px ${t.colours.border}`,
        }}
      >
        <Typography sx={{ fontSize: 9, fontWeight: 600, lineHeight: 1.1, opacity: 0.75, letterSpacing: 0.3 }}>{label}</Typography>
        <Typography noWrap sx={{ fontSize: t.fonts.stripName + 2, fontWeight: 800, lineHeight: 1.15, px: 0.5, maxWidth: '100%' }}>{s.name}</Typography>
      </Box>
      <Box sx={{ px: '4px', py: `${WELL_PAD}px`, borderRadius: '6px', flexShrink: 0, bgcolor: t.colours.faderTrack, boxShadow: `inset 0 2px 6px rgba(0,0,0,.55), inset 0 0 0 1px ${t.colours.border}` }}>
        <Fader valueDb={level} onChange={onLevel} height={faderHeight} disabled={!enabled} label={`${s.name} send`} accent={accent} unconfirmed={unconfirmed} />
      </Box>
      <LevelReadout name={`${s.name} send`} db={level} unconfirmed={unconfirmed} disabled={!enabled} onCommit={onLevel} />
    </Box>
  );
});

const PAD = 6;
const GAP = 6;
const PLATE_H = 40;
const WELL_PAD = 6;
const READOUT_H = 22;
/** Everything in a strip except the fader, so the screen can give the fader the rest of the height. */
export const STRIP_CHROME = PAD * 2 + PLATE_H + WELL_PAD * 2 + READOUT_H + GAP * 2 + 2;

/** Parse what an engineer types for a level: "-6", "+3", "0", "-inf", "off". */
export function parseLevel(text: string): number | null {
  const v = text.trim().toLowerCase().replace(/db$/, '').trim();
  if (v === '-inf' || v === 'inf' || v === 'off' || v === '-∞' || v === '∞') return -Infinity;
  const n = Number(v);
  if (v === '' || !Number.isFinite(n)) return null;
  return n <= FADER_MIN_DB ? -Infinity : Math.min(FADER_MAX_DB, n);
}

/** The level under the fader. Click it to type an exact value. */
function LevelReadout({ name, db, unconfirmed, disabled, onCommit }: { name: string; db: number; unconfirmed: boolean; disabled: boolean; onCommit(db: number): void }) {
  const t = useTokens();
  const [editing, setEditing] = useState(false);
  if (editing && !disabled) {
    return (
      <input
        autoFocus
        aria-label={`${name} level`}
        defaultValue={Number.isFinite(db) ? db.toFixed(1) : '-inf'}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          const v = parseLevel(e.target.value);
          if (v !== null) onCommit(v);
          setEditing(false);
        }}
        style={{ width: 62, height: READOUT_H, boxSizing: 'border-box', font: `600 13px ${t.fonts.mono}`, textAlign: 'center', background: t.colours.faderTrack, color: t.colours.text, border: `1px solid ${t.colours.select}`, borderRadius: 3 }}
      />
    );
  }
  return (
    <Box
      component="button"
      type="button"
      aria-label={`Edit ${name} level`}
      disabled={disabled}
      title={unconfirmed ? 'Not confirmed by the rack yet' : undefined}
      onClick={() => setEditing(true)}
      sx={{
        font: `600 13px ${t.fonts.mono}`, fontVariantNumeric: 'tabular-nums', height: READOUT_H, lineHeight: '20px', px: 0.5, borderRadius: '3px', bgcolor: 'transparent',
        color: unconfirmed ? t.colours.textMuted : t.colours.text, border: `1px ${unconfirmed ? 'dashed' : 'solid'} ${unconfirmed ? t.colours.border : 'transparent'}`,
        cursor: disabled ? 'default' : 'text', '&:hover': { borderColor: disabled ? undefined : t.colours.border },
      }}
    >
      {unconfirmed ? '?' : formatDb(db)}
    </Box>
  );
}
