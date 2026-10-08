import type { Decorator, Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import { UiLabelsProvider } from "../src/components/ui-labels.js";
// biome-ignore lint/correctness/useImportExtensions: stylesheet, not a source file
import "../src/styles/index.css";

/*
 * Global toolbar: theme (light / dark / system). The decorator toggles the same `.light` /
 * `.dark` classes ThemeProvider uses, so stories render exactly as the app does.
 * The a11y addon runs axe on every story; `test: "error"` fails the story on violations.
 */
const withTheme: Decorator = (Story, context) => {
  const theme = String(context.globals["theme"] ?? "light");
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme !== "system") root.classList.add(theme);
  }, [theme]);
  return <Story />;
};

/*
 * The design system ships no words of its own (ADR-0030 §5): the app passes them through
 * `UiLabelsProvider`. Storybook stands in for the app here, in English.
 */
const withLabels: Decorator = (Story) => (
  <UiLabelsProvider
    labels={{
      close: "Close",
      loading: "Loading",
      requestId: "Request id",
      retry: "Try again",
      menu: "Menu",
      notifications: "Notifications",
    }}
  >
    <Story />
  </UiLabelsProvider>
);

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Colour scheme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: ["light", "dark", "system"],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [withTheme, withLabels],
  parameters: {
    a11y: { test: "error" },
    controls: { matchers: { color: /(background|color)$/iu, date: /Date$/u } },
    backgrounds: { disable: true },
    layout: "centered",
  },
};

export default preview;
