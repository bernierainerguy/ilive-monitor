import { useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, FormControlLabel, List, ListItemButton, ListItemText, MenuItem, Select, Stack, Switch, Table, TableBody, TableCell, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Typography,
} from '@mui/material';
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
  const [editing, setEditing] = useState<RackTarget | null>(null);

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
                  <Button variant="contained" disabled={!!(editing.mixConfig && mixConfigError(editing.mixConfig))} onClick={async () => { await invoke('rack:saveTarget', editing); notify('Saved', 'success'); }}>Save</Button>
                  <Button color="error" onClick={async () => { await invoke('rack:deleteTarget', { id: editing.id }); setEditing(null); }}>Delete</Button>
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        )}
      </Stack>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" disabled={!editing || !!(editing.mixConfig && mixConfigError(editing.mixConfig))} onClick={async () => { if (!editing) return; await invoke('rack:saveTarget', editing); await invoke('rack:connect', { targetId: editing.id }); }}>
            Connect{editing ? ` to ${editing.name}` : ''}
          </Button>
          <Button disabled={rack.phase === 'offline'} onClick={() => invoke('rack:disconnect', undefined)}>Disconnect</Button>
        </Stack>
        {rack.lastError?.includes('Local Network') && (
          <Alert severity="warning" sx={{ maxWidth: 640 }} action={<Button color="inherit" size="small" onClick={() => invoke('rack:openLocalNetworkSettings', undefined)}>Open settings</Button>}>
            macOS may be blocking iLive Monitor from the local network. Turn iLive Monitor on under Privacy &amp; Security › Local Network, then quit and reopen the app.
          </Alert>
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
