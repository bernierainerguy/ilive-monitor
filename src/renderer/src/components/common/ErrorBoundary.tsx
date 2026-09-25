import { Component, type ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import { invoke } from '../../api/bridge';

/**
 * One view failing must never blank the whole window mid-show: the failing view
 * shows this card (and logs the error); the title bar, other views and the rack
 * connection keep working. Keyed by route, so moving to another view resets it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onHome?(): void }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    void invoke('log:write', { level: 'error', category: 'system', message: `View crashed: ${error.message}`, data: { stack: info.componentStack ?? error.stack } }).catch(() => undefined);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', p: 3 }}>
        <Stack spacing={1.5} alignItems="center" sx={{ maxWidth: 520, textAlign: 'center' }} role="alert">
          <Typography variant="h6" sx={{ fontWeight: 800 }}>This view hit a problem</Typography>
          <Typography color="text.secondary">The rest of iLive Monitor is fine, and nothing was sent to the rack. The details are in the app's log.</Typography>
          <Typography sx={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.8 }}>{error.message}</Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => this.setState({ error: null })}>Try again</Button>
            {this.props.onHome && <Button onClick={() => { this.setState({ error: null }); this.props.onHome!(); }}>Back to the faders</Button>}
          </Stack>
        </Stack>
      </Box>
    );
  }
}
