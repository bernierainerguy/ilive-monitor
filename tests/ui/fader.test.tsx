import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { dbToFaderPos } from '@shared/domain/units';
import { CAP_H, Fader } from '@renderer/components/fader/Fader';

describe('Fader', () => {
  it('a change of height mid-drag carries on from where the cap is, instead of jumping', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Fader valueDb={0} onChange={onChange} height={300} label="f" />);
    const f = screen.getByRole('slider');
    const capY = (1 - dbToFaderPos(0)) * (300 - CAP_H) + CAP_H / 2; // jsdom: the track sits at y = 0
    fireEvent.pointerDown(f, { pointerId: 1, button: 0, clientY: capY });
    fireEvent.pointerMove(f, { pointerId: 1, clientY: capY + 40 }); // pull down
    const before = onChange.mock.calls.at(-1)![0] as number;
    rerender(<Fader valueDb={0} onChange={onChange} height={500} label="f" />); // taller window
    fireEvent.pointerMove(f, { pointerId: 1, clientY: capY + 40 }); // finger hasn't moved
    expect(onChange.mock.calls.at(-1)![0]).toBeCloseTo(before, 5);
    fireEvent.pointerMove(f, { pointerId: 1, clientY: capY + 50 }); // and moving on is relative to there
    expect(onChange.mock.calls.at(-1)![0]).toBeLessThan(before);
    fireEvent.pointerUp(f, { pointerId: 1 });
  });
});
