import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { clamp, dbToFaderPos, faderPosToDb, formatDb, nudgeFaderDb } from '@shared/domain/units';
import { useTokens } from '../../theme/ThemeProvider';

export interface FaderProps {
  valueDb: number;
  onChange(db: number): void;
  height?: number;
  disabled?: boolean;
  label?: string;
  /** Colour of the cap accent (e.g. SOF target colour). */
  accent?: string;
  /** The rack hasn't confirmed this value (MIDI can't report fader positions): ghost the cap. */
  unconfirmed?: boolean;
}

/** Cap height: sized for a fingertip. Exported so meters can line up with the travel. */
export const CAP_H = 46;
export const FADER_WIDTH = 50;
const RAIL_X = 32; // rail centre
const CAP_W = 30;
const FINE = 0.15;

/**
 * Vertical fader. While the operator holds it, the fader owns its value and
 * ignores incoming props, so rack echoes and other clients can't make it jitter
 * under the finger. Supports drag (relative, no jump), shift = fine, wheel /
 * two-finger trackpad scroll, arrow keys, and double-click (or alt-click) to 0 dB.
 */
export const Fader = memo(function Fader({ valueDb, onChange, height = 260, disabled, label, accent, unconfirmed }: FaderProps) {
  const t = useTokens();
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startPos: number; id: number } | null>(null);
  const [localPos, setLocalPos] = useState<number | null>(null);
  const pos = localPos ?? dbToFaderPos(valueDb);
  const travel = height - CAP_H;

  const emit = useCallback(
    (p: number) => {
      const next = clamp(p, 0, 1);
      setLocalPos(next);
      onChange(faderPosToDb(next));
    },
    [onChange],
  );

  // Release local ownership shortly after interaction ends (wheel/keys have no "up" event).
  const releaseTimer = useRef<ReturnType<typeof setTimeout>>();
  const releaseSoon = () => {
    clearTimeout(releaseTimer.current);
    releaseTimer.current = setTimeout(() => !drag.current && setLocalPos(null), 250);
  };
  useEffect(() => () => clearTimeout(releaseTimer.current), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    if (e.altKey) {
      emit(dbToFaderPos(0));
      releaseSoon();
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = track.current!.getBoundingClientRect();
    const capTop = rect.top + (1 - pos) * travel;
    const onCap = e.clientY >= capTop && e.clientY <= capTop + CAP_H;
    // Click on the cap grabs relatively (no jump); click on the track jumps there first.
    const startPos = onCap ? pos : clamp(1 - (e.clientY - rect.top - CAP_H / 2) / travel, 0, 1);
    if (!onCap) emit(startPos);
    drag.current = { startY: e.clientY, startPos, id: e.pointerId };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const scale = e.shiftKey ? FINE : 1;
    emit(d.startPos - ((e.clientY - d.startY) / travel) * scale);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    releaseSoon();
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = (e.shiftKey ? 0.0005 : 0.002) * -e.deltaY;
    emit(pos + step);
    releaseSoon();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = e.shiftKey ? 0.1 : 1;
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = nudgeFaderDb(valueDb, step);
    else if (e.key === 'ArrowDown') next = nudgeFaderDb(valueDb, -step);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = -Infinity;
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  const scale = [10, 5, 0, -5, -10, -20, -30, -40, -60];
  const held = localPos !== null;
  const tick = (db: number) => CAP_H / 2 + (1 - dbToFaderPos(db)) * travel;

  return (
    <div
      ref={track}
      role="slider"
      aria-label={label ?? 'Fader'}
      aria-valuemin={-90}
      aria-valuemax={10}
      aria-valuenow={Number.isFinite(valueDb) ? Math.round(valueDb * 10) / 10 : -90}
      aria-valuetext={`${formatDb(faderPosToDb(pos))} dB`}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => !disabled && emit(dbToFaderPos(0))}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      style={{ position: 'relative', height, width: FADER_WIDTH, touchAction: 'none', cursor: disabled ? 'not-allowed' : 'ns-resize', opacity: disabled ? 0.45 : 1, outline: 'none' }}
    >
      {scale.map((db) => (
        <div key={db}>
          <div
            style={{
              position: 'absolute', left: 0, width: 12, fontSize: 9, fontWeight: db === 0 ? 700 : 500, color: db === 0 ? t.colours.text : t.colours.textMuted,
              fontFamily: t.fonts.mono, fontVariantNumeric: 'tabular-nums', lineHeight: '9px', top: tick(db) - 4.5, textAlign: 'right',
            }}
          >
            {db === 0 ? '0' : Math.abs(db)}
          </div>
          <div style={{ position: 'absolute', left: 14, width: db === 0 ? 10 : 6, top: tick(db), height: 1, background: db === 0 ? t.colours.text : t.colours.border }} />
        </div>
      ))}
      {/* the slot the cap rides in */}
      <div
        style={{
          position: 'absolute', left: RAIL_X - 2, top: CAP_H / 2 - 4, width: 4, height: travel + 8, borderRadius: 2,
          background: '#000', boxShadow: `inset 0 1px 2px rgba(0,0,0,.8), 0 0 0 1px ${t.colours.border}`,
        }}
      />
      <div
        data-fader-cap
        data-unconfirmed={unconfirmed || undefined}
        title={unconfirmed ? 'Not confirmed by the rack yet: this is the show value until the fader moves here or on the rack' : undefined}
        style={{
          opacity: unconfirmed && !held ? 0.45 : 1,
          outline: unconfirmed && !held ? `1px dashed ${t.colours.textMuted}` : 'none', outlineOffset: 2,
          position: 'absolute', left: RAIL_X - CAP_W / 2, width: CAP_W, height: CAP_H, top: (1 - pos) * travel, borderRadius: 5,
          // a held fader follows the finger exactly; an external change (scene recall, another desk) glides like a motorised one
          transition: held ? 'none' : 'top 160ms cubic-bezier(.2,.7,.2,1)',
          background: t.controls.faderCapStyle === 'classic'
            ? `linear-gradient(180deg, ${t.colours.faderCap} 0%, ${t.colours.faderCap} 42%, #8d949d 50%, ${t.colours.faderCap} 58%, ${t.colours.faderCap} 100%)`
            : t.colours.faderCap,
          boxShadow: held
            ? `0 0 0 2px ${t.colours.select}, 0 4px 10px rgba(0,0,0,.6)`
            : t.controls.faderCapStyle === 'classic' ? '0 3px 6px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.55)' : 'none',
        }}
      >
        {[-9, -5, 5, 9].map((dy) => (
          <div key={dy} style={{ position: 'absolute', left: 5, right: 5, top: CAP_H / 2 + dy, height: 1, background: 'rgba(0,0,0,.28)' }} />
        ))}
        <div style={{ position: 'absolute', top: CAP_H / 2 - 1, left: 2, right: 2, height: 2, borderRadius: 1, background: accent ?? '#1b1d21' }} />
      </div>
    </div>
  );
});
