import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { CssBaseline, ThemeProvider as MuiThemeProvider, createTheme, type Theme } from '@mui/material';
import { BUILTIN_THEMES, DEFAULT_THEME_ID, type ThemeTokens } from '@shared/theme';
import { useAppStore } from '../state/appStore';

/**
 * Tokens are the source of truth. MUI gets a theme derived from them for chrome;
 * canvas-drawn controls (meters, EQ, faders) read tokens directly.
 */
const TokensContext = createContext<ThemeTokens>(BUILTIN_THEMES[0]!);
export const useTokens = () => useContext(TokensContext);

export function resolveTheme(id: string | undefined, custom: ThemeTokens[] = []): ThemeTokens {
  return custom.find((t) => t.id === id) ?? BUILTIN_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

export function muiThemeFrom(t: ThemeTokens): Theme {
  const c = t.colours;
  return createTheme({
    palette: {
      mode: t.mode,
      background: { default: c.background, paper: c.surface },
      primary: { main: c.accent },
      error: { main: c.danger },
      warning: { main: c.pafl },
      ...(c.ok ? { success: { main: c.ok } } : {}),
      text: { primary: c.text, secondary: c.textMuted },
      divider: c.border,
    },
    shape: { borderRadius: t.controls.radius },
    typography: { fontFamily: t.fonts.ui, fontSize: 13 },
    components: {
      MuiButtonBase: { defaultProps: { disableRipple: true } }, // ripples cost frames and add visual latency
      MuiButton: { styleOverrides: { root: { textTransform: 'none', minWidth: 0 } } },
      MuiTab: { styleOverrides: { root: { textTransform: 'none', minHeight: 40 } } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    },
  });
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const themeId = useAppStore((s) => s.settings?.themeId);
  const tokens = useMemo(() => resolveTheme(themeId), [themeId]);
  const mui = useMemo(() => muiThemeFrom(tokens), [tokens]);
  return (
    <TokensContext.Provider value={tokens}>
      <MuiThemeProvider theme={mui}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </TokensContext.Provider>
  );
}
