import { Toaster as Sonner, type ToasterProps, toast } from "sonner";
import { useTheme } from "../theme/theme-provider.js";
import { useUiLabel } from "./ui-labels.js";

export { toast };

/** Mount once near the root, inside `ThemeProvider`. Position is top-center so it stays visible inside short iframes. */
export function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();
  // Sonner's own defaults are English ("Notifications alt+T", "Close toast").
  const region = useUiLabel("notifications", props.customAriaLabel);
  const close = useUiLabel("close", props.toastOptions?.closeButtonAriaLabel);
  return (
    <Sonner
      theme={resolvedTheme}
      customAriaLabel={region}
      position="top-center"
      richColors
      closeButton
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--sh-color-popover)",
          "--normal-text": "var(--sh-color-popover-fg)",
          "--normal-border": "var(--sh-color-border)",
        } as React.CSSProperties
      }
      {...props}
      toastOptions={{ ...props.toastOptions, closeButtonAriaLabel: close }}
    />
  );
}
