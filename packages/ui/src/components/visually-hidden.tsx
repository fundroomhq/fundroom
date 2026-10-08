import { VisuallyHidden as VisuallyHiddenPrimitive } from "radix-ui";
import type * as React from "react";

export function VisuallyHidden(props: React.ComponentProps<typeof VisuallyHiddenPrimitive.Root>) {
  return <VisuallyHiddenPrimitive.Root data-slot="visually-hidden" {...props} />;
}
