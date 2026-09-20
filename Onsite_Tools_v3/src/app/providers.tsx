'use client';

import * as React from 'react';
import Link from 'next/link';
import { Theme } from '@astryxdesign/core/theme';
import type { ThemeMode } from '@astryxdesign/core/theme';
import { LinkProvider } from '@astryxdesign/core/Link';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { ToastAboveDialogs } from '@/components/toast-above-dialogs';

/**
 * Color mode lives here, beside the Theme it drives. The mode is a COOKIE, not
 * localStorage, so the server layout can stamp data-theme on <html> before a
 * single byte of CSS applies — a stored choice never flashes the other theme.
 * "system" is the default and cannot be stamped on the server (the server does
 * not know the OS), so the layout pairs it with a tiny pre-hydration script;
 * after hydration the Astryx root Theme owns the attribute and follows OS
 * changes live.
 */
const ThemeModeContext = React.createContext<{
  mode: ThemeMode;
  /** What the screen is actually showing — "system" already resolved. The
   *  quick toggle reads this to know which way it flips. */
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}>({ mode: 'system', resolved: 'light', setMode: () => {} });

function subscribeToSystemScheme(onChange: () => void) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function useThemeMode() {
  return React.useContext(ThemeModeContext);
}

export function Providers({
  children,
  initialMode = 'system',
  initialSystemDark = false,
}: {
  children: React.ReactNode;
  initialMode?: ThemeMode;
  /** What "system" resolved to on the last visit (the theme-sys cookie) — the
   *  server snapshot below, so SSR and hydration agree instead of warning. */
  initialSystemDark?: boolean;
}) {
  const [mode, setModeState] = React.useState<ThemeMode>(initialMode);
  const setMode = React.useCallback((next: ThemeMode) => {
    setModeState(next);
    // A year, not a session: a theme choice is the kind of thing losing feels
    // like a bug. SameSite=Lax and no HttpOnly — this is preference, not auth.
    document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax`;
  }, []);
  // value is assembled AFTER resolved below.

  // "system" is resolved HERE and Theme always receives an explicit light or
  // dark. Handed "system", the Astryx root Theme REMOVES data-theme and leaves
  // dark to the browser's color-scheme — which its own light-dark() styling
  // follows, but our token block ([data-theme="dark"]) and Tailwind's dark:
  // variant do not. Resolving once and stamping the attribute drives both
  // systems through the same switch.
  //
  // useSyncExternalStore, and NOT lazy useState reading matchMedia: the server
  // snapshot is light, and when the OS says dark the store forces a re-render
  // right after hydration. A lazy initial state that already said dark renders
  // markup React then REFUSES to reconcile — hydration does not patch
  // attribute mismatches — and the Theme wrapper's color-scheme:light class
  // from the server HTML would stand for the life of the page, which is
  // exactly the white-cards-on-a-dark-page bug this replaced.
  const systemDark = React.useSyncExternalStore(
    subscribeToSystemScheme,
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    () => initialSystemDark
  );
  // Keep the hint honest for the NEXT server render (the pre-paint script
  // writes it too, but only on full loads — this covers OS changes mid-visit).
  React.useEffect(() => {
    document.cookie = `theme-sys=${systemDark ? 'dark' : 'light'}; path=/; max-age=31536000; samesite=lax`;
  }, [systemDark]);
  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const value = React.useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return (
    <ThemeModeContext.Provider value={value}>
      <Theme theme={neutralTheme} mode={resolved}>
        <LinkProvider component={Link}>{children}</LinkProvider>
        {/* Renders nothing; keeps a toast above any dialog that opened after the
            toast viewport entered the top layer. */}
        <ToastAboveDialogs />
      </Theme>
    </ThemeModeContext.Provider>
  );
}
