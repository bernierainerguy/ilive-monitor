import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, FormControlLabel, List, ListItemButton, ListItemText, MenuItem, Select, Stack, Switch, Table, TableBody, TableCell, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Typography, Checkbox,
} from '@mui/material';
import type { RackNames } from '@shared/rack';
import { channelLabels, layoutMismatches, suggestMixConfig } from '@shared/mixConfigFromNames';
import { MIX_CHANNELS, SEND_BUSES, mixChannelCount, mixConfigError, sendBusCount, type RackMixConfig } from '@shared/mixLayout';
import type { RackTarget } from '@shared/settings';
import { invoke } from '../../api/bridge';
import { useAppStore } from '../../state/appStore';
import { EMPTY } from '../../state/mixerStore';

const ILIVE_PORT = 51325;

/** Settings → Rack: saved racks, their mix configuration, connect/disconnect and live health. */
export function RackSettings() {
  const rack = useAppStore((s) => s.rack);
  const targets = useAppStore((s) => s.settings?.racks ?? EMPTY);
  const notify = useAppStore((s) => s.notify);
  // Start on the rack in use, else the first saved one, so Connect is ready to press.
  const [editing, setEditing] = useState<RackTarget | null>(() => targets.find((x) => x.id === rack.targetId) ?? targets[0] ?? null);
  // Already on this rack: Connect would only drop the link (Save applies an edited address or configuration).
  const connected = !!editing && rack.targetId === editing.id && (rack.phase === 'online' || rack.phase === 'degraded');
  // Read from rack: the rack's own names, what they suggest, and the operator's confirmation of what they can't show.
  const [names, setNames] = useState<RackNames | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [mustConfirm, setMustConfirm] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setNames(null);
    setNotes([]);
    setMustConfirm(false);
    setConfirmed(false);
  }, [editing?.id]);
  // After a read, nothing is saved until groups and FX sends have been checked: a wrong guess misroutes every send.
  const awaitingCheck = mustConfirm && !confirmed;
  const readFromRack = () =>
    void attempt(async () => {
      if (!editing) return;
      const read = await invoke('rack:readNames', { targetId: editing.id });
      const reading = suggestMixConfig(read.mixes, editing.mixConfig);
      setNames(read);
      setNotes(reading.notes);
      setMustConfirm(true);
      setConfirmed(false);
      if (reading.clean) setEditing({ ...editing, mixConfig: reading.config });
    });
  // What's on screen differs from what's saved: say so, since nothing applies until Save.
  const saved = targets.find((t) => t.id === editing?.id);
  const dirty = !!editing && JSON.stringify(saved ?? null) !== JSON.stringify(editing);
  const saveBlocked = !editing || awaitingCheck || !!(editing.mixConfig && mixConfigError(editing.mixConfig));
  const save = () =>
    void attempt(async () => {
      if (!editing) return;
      await invoke('rack:saveTarget', editing);
      setMustConfirm(false);
      notify('Saved', 'success');
    });
  // A refused save (a bad port, or Settings locked meanwhile) says why instead of failing silently.
  const attempt = (fn: () => Promise<unknown>) =>
    fn().catch((e: Error) => notify(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'));

  const h = rack.health;
  const rows: Array<[string, string]> = [
    ['Rack name', rack.identity?.name ?? '—'],
    ['Model', rack.identity?.model ?? '—'],
    ['Firmware', rack.identity?.firmware ?? (rack.identity ? 'not reported by protocol' : '—')],
    ['IP address', rack.identity?.ip ?? '—'],
    ['Status', rack.phase],
    ['Send levels', !rack.identity ? '—' : rack.capabilities.sends ? 'reach the rack' : 'locked: enter the mix configuration'],
    ['Round-trip latency', h.rttMs !== null ? `${h.rttMs.toFixed(1)} ms (avg ${h.rttAvgMs?.toFixed(1)} ms)` : '—'],
    ['Missed probes', String(h.missedProbes)],
    ['Reconnects', String(h.reconnects)],
    ['Errors', String(h.errors)],
    ['Last error', rack.lastError ?? '—'],
  ];

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 340px) 1fr', gap: 2 }}>
      <Stack spacing={1}>
        <Typography variant="overline">Saved racks</Typography>
        <List dense>
          {targets.map((t) => (
            <ListItemButton key={t.id} selected={rack.targetId === t.id} onClick={() => setEditing(t)}>
              <ListItemText primary={t.name} secondary={t.protocol === 'simulator' ? 'Built-in simulator' : `${t.host}:${t.port} · MIDI ch ${t.midiChannel + 1}`} />
            </ListItemButton>
          ))}
        </List>
        <Button onClick={() => setEditing({ id: crypto.randomUUID(), name: 'iDR48', host: '192.168.1.70', port: ILIVE_PORT, protocol: 'ilive-midi-tcp', midiChannel: 0, autoConnect: true })}>
          Add rack
        </Button>
        {editing && (
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1.5}>
                <TextField size="small" label="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <Select size="small" value={editing.protocol} onChange={(e) => setEditing({ ...editing, protocol: e.target.value as RackTarget['protocol'] })}>
                  <MenuItem value="ilive-midi-tcp">iLive MIDI over TCP</MenuItem>
                  <MenuItem value="simulator">Simulator</MenuItem>
                </Select>
                {editing.protocol !== 'simulator' && <>
                  <TextField size="small" label="IP address" value={editing.host} onChange={(e) => setEditing({ ...editing, host: e.target.value.trim() })} />
                  <TextField size="small" type="number" label="Port" value={editing.port} onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) })} />
                  <TextField size="small" type="number" label="MIDI channel (1–16)" value={editing.midiChannel + 1} inputProps={{ min: 1, max: 16 }}
                    onChange={(e) => setEditing({ ...editing, midiChannel: Math.max(0, Math.min(15, Number(e.target.value) - 1)) })} />
                </>}
                {editing.protocol === 'ilive-midi-tcp' && <MixConfigFields value={editing.mixConfig} onChange={(mixConfig) => setEditing({ ...editing, mixConfig })} />}
                <FormControlLabel control={<Switch checked={editing.autoConnect} onChange={(_, v) => setEditing({ ...editing, autoConnect: v })} />} label="Reconnect on launch" />
                <Stack direction="row" spacing={1}>
                  <Button variant="contained" disabled={saveBlocked} onClick={save}>Save</Button>
                  <Button color="error" onClick={() => void attempt(async () => { await invoke('rack:deleteTarget', { id: editing.id }); setEditing(null); })}>Delete</Button>
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        )}
      </Stack>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" disabled={!editing || connected || awaitingCheck || !!(editing.mixConfig && mixConfigError(editing.mixConfig))} onClick={() => void attempt(async () => { if (!editing) return; await invoke('rack:saveTarget', editing); await invoke('rack:connect', { targetId: editing.id }); })}>
            {connected ? 'Connected' : 'Connect'}{editing ? ` to ${editing.name}` : ''}
          </Button>
          <Button disabled={rack.phase === 'offline'} onClick={() => void attempt(() => invoke('rack:disconnect', undefined))}>Disconnect</Button>
        </Stack>
        {rack.lastError?.includes('Local Network') && (
          <Alert severity="warning" sx={{ maxWidth: 640 }} action={<Button color="inherit" size="small" onClick={() => invoke('rack:openLocalNetworkSettings', undefined)}>Open settings</Button>}>
            macOS may be blocking iLive Monitor from the local network. Turn iLive Monitor on under Privacy &amp; Security › Local Network, then quit and reopen the app.
          </Alert>
        )}
        {editing?.protocol === 'ilive-midi-tcp' && (
          <RackLayout
            config={editing.mixConfig}
            names={names}
            notes={notes}
            canRead={connected}
            onRead={readFromRack}
            mustConfirm={mustConfirm}
            confirmed={confirmed}
            onConfirm={setConfirmed}
            dirty={dirty}
            canSave={!saveBlocked}
            onSave={save}
          />
        )}
        <Table size="small" sx={{ maxWidth: 640 }}>
          <TableBody>
            {rows.map(([k, v]) => <TableRow key={k}><TableCell sx={{ width: 200, color: 'text.secondary' }}>{k}</TableCell><TableCell>{v}</TableCell></TableRow>)}
          </TableBody>
        </Table>
      </Stack>
    </Box>
  );
}

/** The app's own default layout, as a starting point: 8 groups, 12 auxes, Main LR + mono, 8 matrices, 8 FX. */
const STARTER: RackMixConfig = { monoGroups: 8, stereoGroups: 0, monoAuxes: 12, stereoAuxes: 0, main: 'lrMono', monoMatrices: 8, stereoMatrices: 0, monoFx: 8, stereoFx: 0 };

const ROWS: Array<{ label: string; mono: keyof RackMixConfig; stereo: keyof RackMixConfig }> = [
  { label: 'Groups', mono: 'monoGroups', stereo: 'stereoGroups' },
  { label: 'Auxes', mono: 'monoAuxes', stereo: 'stereoAuxes' },
  { label: 'Matrices', mono: 'monoMatrices', stereo: 'stereoMatrices' },
  { label: 'FX sends', mono: 'monoFx', stereo: 'stereoFx' },
];

/**
 * The rack's mix configuration. MIDI can't report it, and the rack numbers its
 * send buses by it, so without it sends can't reach the rack and the faders
 * stay locked.
 */
function MixConfigFields({ value, onChange }: { value: RackMixConfig | undefined; onChange(v: RackMixConfig | undefined): void }) {
  const error = value ? mixConfigError(value) : null;
  return (
    <Box role="group" aria-label="Rack mix configuration" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
      <FormControlLabel
        control={<Switch checked={!!value} onChange={(_, on) => onChange(on ? STARTER : undefined)} />}
        label="Rack mix configuration"
      />
      {!value ? (
        <Typography variant="caption" color="text.secondary" component="p">
          Enter the MixRack&apos;s mixer configuration. The rack numbers its send buses by it, so without it the faders stay locked.
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">In the rack&apos;s order. MIDI can&apos;t read this from the rack, so copy it from the rack&apos;s mixer config.</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 72px 72px', gap: 0.75, alignItems: 'center' }}>
            <span />
            <Typography variant="caption" color="text.secondary">Mono</Typography>
            <Typography variant="caption" color="text.secondary">Stereo</Typography>
            {ROWS.map((r) => (
              <Box key={r.label} sx={{ display: 'contents' }}>
                <Typography variant="body2">{r.label}</Typography>
                {([r.mono, r.stereo] as const).map((k, i) => (
                  <TextField
                    key={k}
                    size="small"
                    type="number"
                    inputProps={{ min: 0, max: 32, 'aria-label': `${i ? 'Stereo' : 'Mono'} ${r.label.toLowerCase()}` }}
                    value={value[k]}
                    onChange={(e) => onChange({ ...value, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                  />
                ))}
              </Box>
            ))}
          </Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="body2" sx={{ flex: 1 }}>Main</Typography>
            <ToggleButtonGroup size="small" exclusive value={value.main} onChange={(_, v) => v && onChange({ ...value, main: v })} aria-label="Main mix">
              <ToggleButton value="lr">LR</ToggleButton>
              <ToggleButton value="lrMono">LR + mono</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          {error ? (
            <Typography variant="caption" color="error" role="alert">{error}</Typography>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Uses {mixChannelCount(value)} of {MIX_CHANNELS} mix channels and {sendBusCount(value)} of {SEND_BUSES} send buses.
            </Typography>
          )}
        </Stack>
      )}
    </Box>
  );
}

/**
 * Read from rack, and the layout preview: what the mix configuration makes of each of the rack's 32 mix channels,
 * beside the name the rack gives it. Disagreements are marked, so a wrong number shows before anything is sent.
 */
function RackLayout({ config, names, notes, canRead, onRead, mustConfirm, confirmed, onConfirm, dirty, canSave, onSave }: {
  config: RackMixConfig | undefined; names: RackNames | null; notes: string[]; canRead: boolean; onRead(): void;
  mustConfirm: boolean; confirmed: boolean; onConfirm(v: boolean): void; dirty: boolean; canSave: boolean; onSave(): void;
}) {
  const labels = config ? channelLabels(config) : null;
  const bad = new Set(config && names ? layoutMismatches(config, names.mixes) : []);
  const used = names ? names.mixes.reduce((n, x, i) => (x !== null ? i + 1 : n), 0) : 0;
  const rows = Math.max(used, labels ? labels.reduce((n, l, i) => (l !== '—' ? i + 1 : n), 0) : 0);
  return (
    <Box role="group" aria-label="Rack layout" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, maxWidth: 640 }}>
      {dirty && !mustConfirm && (
        <Alert severity="info" sx={{ mb: 1 }} action={<Button color="inherit" size="small" disabled={!canSave} onClick={onSave}>Save</Button>}>
          Not saved yet: nothing reaches the rack until you save.
        </Alert>
      )}
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <Button variant="outlined" size="small" disabled={!canRead} onClick={onRead}>Read from rack</Button>
        <Typography variant="caption" color="text.secondary">
          {canRead ? 'Reads the rack’s mix names and fills in the mix configuration they show. Nothing on the rack changes.' : 'Connect to this rack first: the names come from the rack.'}
        </Typography>
      </Stack>
      {mustConfirm && (
        <Alert severity={bad.size ? 'error' : 'warning'} sx={{ mb: 1 }}>
          {notes.map((n) => <Typography key={n} variant="body2" sx={{ mb: 0.5 }}>{n}</Typography>)}
          {bad.size > 0 && <Typography variant="body2" sx={{ fontWeight: 700 }}>{bad.size} channel{bad.size === 1 ? '' : 's'} below don’t match the rack.</Typography>}
          <FormControlLabel
            control={<Checkbox size="small" checked={confirmed} onChange={(_, v) => onConfirm(v)} />}
            label="I’ve checked the groups and FX sends against the rack’s Mixer Config"
          />
          {/* Save here too, beside the tick that unlocks it: nothing applies to the rack until it's saved. */}
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 0.5 }}>
            <Button variant="contained" size="small" disabled={!canSave} onClick={onSave}>Save</Button>
            <Typography variant="body2">{confirmed ? 'Saving reconnects with this configuration and unlocks the faders.' : 'Tick the box to save.'}</Typography>
          </Stack>
        </Alert>
      )}
      {rows > 0 && (
        <Box aria-label="Mix channels" sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', columnGap: 2, rowGap: '2px', gridAutoFlow: 'column', gridTemplateRows: `repeat(${Math.ceil(rows / 2)}, auto)` }}>
          {Array.from({ length: rows }, (_, i) => (
            <Typography
              key={i}
              variant="body2"
              data-mismatch={bad.has(i) || undefined}
              sx={{ fontVariantNumeric: 'tabular-nums', color: bad.has(i) ? 'error.main' : undefined, fontWeight: bad.has(i) ? 700 : 400 }}
            >
              <Box component="span" sx={{ color: 'text.secondary', display: 'inline-block', width: 52 }}>Mix {i + 1}</Box>
              <Box component="span" sx={{ display: 'inline-block', width: 88 }}>{labels?.[i] ?? '—'}</Box>
              {names ? (names.mixes[i] ?? <Box component="span" sx={{ color: 'text.secondary' }}>not used</Box>) : ''}
            </Typography>
          ))}
        </Box>
      )}
      {names && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          FX sends on the rack: {names.fx.map((f, i) => f ?? `${i + 1} (not used)`).join(', ')}
        </Typography>
      )}
    </Box>
  );
}
