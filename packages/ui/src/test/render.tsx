import { type RenderOptions, render as rtlRender } from "@testing-library/react";
import type * as React from "react";
import { type UiLabels, UiLabelsProvider } from "../components/ui-labels.js";

/*
 * Component tests render inside `UiLabelsProvider`, as the app does (the app passes words from
 * its catalogue; these stand in). `render` is Testing Library's, wrapped; everything else is
 * re-exported unchanged.
 */
export const TEST_LABELS: UiLabels = {
  close: "Close",
  loading: "Loading",
  requestId: "Request id",
  retry: "Try again",
  menu: "Menu",
  notifications: "Notifications",
};

function Wrapper({ children }: { children: React.ReactNode }) {
  return <UiLabelsProvider labels={TEST_LABELS}>{children}</UiLabelsProvider>;
}

export function render(ui: React.ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}

export { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
