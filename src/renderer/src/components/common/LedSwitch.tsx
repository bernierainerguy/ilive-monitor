import { memo, type ReactNode } from 'react';
import { Box } from '@mui/material';
import { useTokens } from '../../theme/ThemeProvider';

/**
 * Console push-switch with a status LED (48V, Pad, Ø, block IN...).
 * `solid` fills the whole key with its colour when on: used for MUTE and PAFL,
 * which must be readable from across the room, not just by a small LED.
 */
export const LedSwitch = memo(function LedSwitch({ on, onClick, label, children, led, disabled, width = 64, height = 30, solid, unconfirmed }: {
  on: boolean;
  onClick(): void;
  /** Accessible name. */
  label: string;
  children: ReactNode;
  /** LED colour when on; defaults to the theme accent. */
  led?: string;
  disabled?: boolean;
  width?: number;
  height?: number;
  solid?: boolean;
  /** The rack hasn't confirmed this state: dashed border, dimmed. */
  unconfirmed?: boolean;
}) {
  const t = useTokens();
  const colour = led ?? t.colours.accent;
  const filled = solid && on;
  return (
    <Box
      component="button"
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      data-unconfirmed={unconfirmed || undefined}
      title={unconfirmed ? 'Not confirmed by the rack yet: this is the show value' : undefined}
      sx={{
        width, height, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 0.75, p: 0, flexShrink: 0,
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : unconfirmed ? 0.6 : 1,
        color: filled ? '#000' : on ? t.colours.text : t.colours.textMuted, borderRadius: '4px',
        border: `1px ${unconfirmed ? 'dashed' : 'solid'} ${on ? colour : unconfirmed ? t.colours.textMuted : t.colours.border}`,
        background: filled ? `linear-gradient(${colour}, ${colour}cc)` : `linear-gradient(${t.colours.surfaceRaised}, ${t.colours.surface})`,
        boxShadow: filled ? `0 0 10px ${colour}88` : on ? `inset 0 0 10px ${colour}33` : 'inset 0 -2px 0 rgba(0,0,0,.25)',
      }}
    >
      <Box
        component="span"
        aria-hidden
        sx={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          bgcolor: filled ? '#fff' : on ? colour : t.colours.faderTrack,
          boxShadow: filled ? '0 0 6px #fff' : on ? `0 0 6px ${colour}` : 'none',
          border: `1px solid ${filled ? '#fff' : on ? colour : t.colours.border}`,
        }}
      />
      {children}
    </Box>
  );
});
