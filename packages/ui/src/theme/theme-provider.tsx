import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

export interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  /** Pin the theme (e.g. a host page's `color-scheme` token); `setTheme` becomes a no-op. */
  forcedTheme?: Theme | undefined;
}

const QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(QUERY).matches ? "dark" : "light";
}

function readStored(key: string): Theme | undefined {
  try {
    const v = window.localStorage.getItem(key);
    return v === "light" || v === "dark" || v === "system" ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeStored(key: string, theme: Theme): void {
  try {
    window.localStorage.setItem(key, theme);
  } catch {
    /* private mode / blocked storage: keep in memory only */
  }
}

/** Sets `.light` / `.dark` on <html>; `system` removes both so `tokens.css`'s media query applies. */
export function applyThemeClass(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.classList.remove("light", "dark");
  if (theme !== "system") root.classList.add(theme);
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "seed-host:theme",
  forcedTheme,
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(
    () =>
      forcedTheme ??
      (typeof window !== "undefined" ? readStored(storageKey) : undefined) ??
      defaultTheme,
  );
  const [system, setSystem] = React.useState<ResolvedTheme>(() => systemTheme());
  const effective = forcedTheme ?? theme;

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  React.useEffect(() => {
    applyThemeClass(effective);
  }, [effective]);

  const setTheme = React.useCallback(
    (next: Theme) => {
      if (forcedTheme !== undefined) return;
      setThemeState(next);
      writeStored(storageKey, next);
    },
    [forcedTheme, storageKey],
  );

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme: effective,
      resolvedTheme: effective === "system" ? system : effective,
      setTheme,
    }),
    [effective, system, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Outside a provider: reports the system theme and ignores `setTheme`. */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (ctx) return ctx;
  return { theme: "system", resolvedTheme: systemTheme(), setTheme: () => {} };
}
