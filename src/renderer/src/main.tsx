import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { invoke } from './api/bridge';
import { startSync } from './services/sync';

window.addEventListener('error', (e) => void invoke('log:write', { level: 'error', category: 'crash', message: e.message, data: { source: e.filename, line: e.lineno } }).catch(() => undefined));
window.addEventListener('unhandledrejection', (e) => void invoke('log:write', { level: 'error', category: 'crash', message: String(e.reason) }).catch(() => undefined));

void startSync().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
