import * as React from "react";

/*
 * The few words the design system itself needs (ADR-0030 §5: components stay string-free).
 *
 * `packages/ui` carries no i18n dependency and no English: the app provides these once, from its
 * message catalogue, with `<UiLabelsProvider>` at the root, and any single use can override one
 * through the component's own prop (`closeLabel`, `label`, …). A component that finds neither
 * throws, because the alternative is an unnamed close button or an English word in a French
 * screen — both of which ship silently.
 */
export interface UiLabels {
  /** Accessible name of a dialog's close button. */
  readonly close: string;
  /** Screen-reader text of `Spinner` and `LoadingState`. */
  readonly loading: string;
  /** "Request id" before the id `ErrorState` shows. */
  readonly requestId: string;
  /** `ErrorState`'s retry button. */
  readonly retry: string;
  /** Accessible name of `AppShell`'s small-screen menu button and drawer. */
  readonly menu: string;
  /** Accessible name of the `Toaster` region (its close buttons use `close`). */
  readonly notifications: string;
}

const UiLabelsContext = React.createContext<UiLabels | undefined>(undefined);

export function UiLabelsProvider({
  labels,
  children,
}: {
  labels: UiLabels;
  children: React.ReactNode;
}) {
  return <UiLabelsContext.Provider value={labels}>{children}</UiLabelsContext.Provider>;
}

/** The label for `key`: the explicit prop when given, else the provider's. Throws without either. */
export function useUiLabel<K extends keyof UiLabels>(key: K, explicit: string | undefined): string;
export function useUiLabel<K extends keyof UiLabels>(
  key: K,
  explicit: React.ReactNode | undefined,
): React.ReactNode;
export function useUiLabel<K extends keyof UiLabels>(
  key: K,
  explicit: React.ReactNode | undefined,
): React.ReactNode {
  const labels = React.useContext(UiLabelsContext);
  if (explicit !== undefined && explicit !== null) return explicit;
  const fromProvider = labels?.[key];
  if (fromProvider === undefined) {
    throw new Error(
      `@fundroomhq/ui: no "${key}" label — pass it as a prop or render inside <UiLabelsProvider>`,
    );
  }
  return fromProvider;
}
