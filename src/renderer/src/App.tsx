import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { subscribe } from './api/bridge';
import { Shell } from './shell/Shell';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { AppThemeProvider } from './theme/ThemeProvider';
import MixScreen from './screens/MixScreen';

const SettingsScreen = lazy(() => import('./screens/SettingsScreen'));

/** A per-view error boundary: keyed by route so switching views gives a fresh one. */
function ViewBoundary({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const nav = useNavigate();
  return <ErrorBoundary key={loc.pathname} onHome={() => nav('/mix')}>{children}</ErrorBoundary>;
}

function NavBridge() {
  const nav = useNavigate();
  useEffect(() => subscribe('nav:goto', ({ path }) => nav(path)), [nav]);
  return null;
}

export function App() {
  return (
    <AppThemeProvider>
      <HashRouter>
        <NavBridge />
        <Shell>
          <ViewBoundary>
            <Suspense fallback={<Box sx={{ display: 'grid', placeItems: 'center', height: '100%' }}><CircularProgress /></Box>}>
              <Routes>
                <Route path="/mix" element={<MixScreen />} />
                <Route path="/settings" element={<SettingsScreen />} />
                <Route path="*" element={<Navigate to="/mix" replace />} />
              </Routes>
            </Suspense>
          </ViewBoundary>
        </Shell>
      </HashRouter>
    </AppThemeProvider>
  );
}
