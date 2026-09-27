import { describe, expect, it } from 'vitest';
import { channelLabels, layoutMismatches, suggestMixConfig } from '@shared/mixConfigFromNames';
import { mixLayout } from '@shared/mixLayout';

// What Bernie's iDR48 answered on 2026-09-27 (CH 60..7F).
const STUDIO: Array<string | null> = [
  'ComOut', 'LOOP', 'Talk', 'Proprese',
  'Gtr', 'Gtr', 'Keys', 'Keys', 'Bass', 'Bass', 'Drums', 'Drums', 'V1', 'V1', 'V2', 'V2', 'V3', 'V3', 'V', 'V', '9', '9', '10', '10',
  'Main', 'FOH R',
  null, null, null, null, null, null,
];

// A&H's documented template 1_FOH-LRSub (MIDI Protocol V1.91 p2), with its stock names.
const FOH_LRSUB: Array<string | null> = [
  'Grp1', 'Grp2', 'Grp3', 'Grp4', 'StGrp1', 'StGrp1', 'StGrp2', 'StGrp2',
  'Aux1', 'Aux2', 'Aux3', 'Aux4', 'Aux5', 'Aux6', 'Aux7', 'Aux8', 'StAux1', 'StAux1', 'StAux2', 'StAux2',
  'Main L', 'Main R', 'Main Sub', null,
  'Mtx1', 'Mtx2', 'Mtx3', 'Mtx4', 'StMtx1', 'StMtx1', 'StMtx2', 'StMtx2',
];

describe('reading the mix configuration from the rack’s names', () => {
  it('the studio rack: 4 mono auxes, 10 stereo auxes, main LR, nothing after', () => {
    const r = suggestMixConfig(STUDIO);
    expect(r.clean).toBe(true);
    expect(r.config).toEqual({ monoGroups: 0, stereoGroups: 0, monoAuxes: 4, stereoAuxes: 10, main: 'lr', monoMatrices: 0, stereoMatrices: 0, monoFx: 0, stereoFx: 0 });
    expect(r.notes.join(' ')).toMatch(/groups/);
    expect(r.notes.join(' ')).toMatch(/FX sends/);
    expect(layoutMismatches(r.config, STUDIO)).toEqual([]);
  });

  it('keeps the FX counts already entered, since the names can’t show them', () => {
    const current = { monoGroups: 0, stereoGroups: 0, monoAuxes: 0, stereoAuxes: 0, main: 'lr' as const, monoMatrices: 0, stereoMatrices: 0, monoFx: 4, stereoFx: 0 };
    expect(suggestMixConfig(STUDIO, current).config).toMatchObject({ monoAuxes: 4, stereoAuxes: 10, monoFx: 4, stereoFx: 0 });
  });

  it('A&H’s 1_FOH-LRSub template: groups, auxes, LR + Sub and matrices all found', () => {
    const r = suggestMixConfig(FOH_LRSUB, { monoFx: 6, stereoFx: 0 } as never);
    expect(r.clean).toBe(true);
    expect(r.config).toEqual({ monoGroups: 4, stereoGroups: 2, monoAuxes: 8, stereoAuxes: 2, main: 'lrMono', monoMatrices: 4, stereoMatrices: 2, monoFx: 6, stereoFx: 0 });
    // …and it sends Aux 1 on Snd 2E and StAux1 on 36/37, exactly as the document's table does.
    const layout = mixLayout(r.config);
    const auxes = layout.slots.flatMap((s, i) => (s.role === 'aux' ? [i] : []));
    expect(layout.mixSends.get(auxes[0]!)).toEqual([0x2e]);
    expect(layout.mixSends.get(auxes[8]!)).toEqual([0x36, 0x37]);
  });

  it('says so, rather than guessing, when the names don’t fit the rack’s order', () => {
    expect(suggestMixConfig([]).clean).toBe(false);
    expect(suggestMixConfig(['A', 'B', 'C', null]).clean).toBe(false); // no main
    expect(suggestMixConfig(['Aux', 'St', 'St', 'Aux2', 'St2', 'St2', 'Aux3', 'Main', 'FOH R']).clean).toBe(false); // too many runs
  });
});

describe('the layout preview', () => {
  it('labels each rack channel as the configuration sees it', () => {
    const labels = channelLabels(suggestMixConfig(STUDIO).config);
    expect(labels.slice(0, 7)).toEqual(['Aux 1', 'Aux 2', 'Aux 3', 'Aux 4', 'Aux 5 L', 'Aux 5 R', 'Aux 6 L']);
    expect(labels.slice(22, 27)).toEqual(['Aux 14 L', 'Aux 14 R', 'Main L', 'Main R', '—']);
  });

  it('flags channels where the configuration and the rack disagree', () => {
    const wrong = { monoGroups: 0, stereoGroups: 0, monoAuxes: 3, stereoAuxes: 10, main: 'lr' as const, monoMatrices: 0, stereoMatrices: 0, monoFx: 0, stereoFx: 0 };
    // One mono aux short: every stereo pair lands one channel early, so their halves no longer match.
    expect(layoutMismatches(wrong, STUDIO).length).toBeGreaterThan(10);
  });
});
