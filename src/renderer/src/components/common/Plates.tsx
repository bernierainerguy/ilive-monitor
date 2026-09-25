import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import type { StripColour } from '@shared/domain/model';
import { plateInk } from '@shared/theme';
import { useTokens } from '../../theme/ThemeProvider';

/**
 * Small pieces shared by the management screens so they read like the strip and
 * the processing editor: a lit name plate in the channel's colour, and key-style
 * tabs that can carry an in-use LED.
 */
export function NameChip({ colour, label, name, width, onClick }: { colour: StripColour; label: string; name: string; width?: number | string; onClick?(): void }) {
  const t = useTokens();
  const lit = colour !== 'off';
  const bg = lit ? t.strip[colour] : t.colours.surfaceRaised;
  return (
    <Box
      component={onClick ? 'button' : 'div'}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      sx={{
        display: 'flex', alignItems: 'center', gap: 0.75, px: 1, height: 30, borderRadius: '6px', border: 'none', minWidth: 0, width,
        bgcolor: bg, color: lit ? plateInk(bg, t) : t.colours.text, cursor: onClick ? 'pointer' : 'default', lineHeight: 1,
        boxShadow: lit ? `inset 0 1px 0 rgba(255,255,255,.3), inset 0 -2px 0 rgba(0,0,0,.2)` : `inset 0 0 0 1px ${t.colours.border}`,
      }}
    >
      <Typography component="span" sx={{ fontSize: 10, fontWeight: 700, opacity: 0.75, flexShrink: 0 }}>{label}</Typography>
      <Typography component="span" noWrap sx={{ fontSize: 13, fontWeight: 800, minWidth: 0 }}>{name}</Typography>
    </Box>
  );
}

export function KeyTabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string; lit?: boolean }>; value: T; onChange(id: T): void; label: string }) {
  const t = useTokens();
  return (
    <Box role="tablist" aria-label={label} sx={{ display: 'flex', gap: '4px', overflowX: 'auto', py: '2px', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
      {tabs.map((tab) => {
        const on = tab.id === value;
        return (
          <Box
            key={tab.id}
            component="button"
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.id)}
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: '7px', height: 36, px: 1.75, flexShrink: 0, cursor: 'pointer',
              borderRadius: '8px', fontSize: 13, fontWeight: 700, fontFamily: t.fonts.ui,
              color: on ? t.colours.text : t.colours.textMuted, bgcolor: on ? t.colours.surfaceRaised : 'transparent',
              border: `1px solid ${on ? t.colours.select : 'transparent'}`, boxShadow: on ? `inset 0 -2px 0 ${t.colours.select}` : 'none',
              '&:hover': { color: t.colours.text, bgcolor: t.colours.surfaceRaised },
            }}
          >
            {tab.lit !== undefined && (
              <Box component="span" aria-hidden sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: tab.lit ? t.colours.accent : t.colours.faderTrack, boxShadow: tab.lit ? `0 0 6px ${t.colours.accent}` : `inset 0 0 0 1px ${t.colours.border}` }} />
            )}
            {tab.label}
          </Box>
        );
      })}
    </Box>
  );
}

/** A section caption, as used across the console-style screens. */
export function Caption({ children }: { children: ReactNode }) {
  const t = useTokens();
  return <Typography sx={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.2, textTransform: 'uppercase', color: t.colours.textMuted, mb: 1 }}>{children}</Typography>;
}
