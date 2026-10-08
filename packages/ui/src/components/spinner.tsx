import { Loader2Icon } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/cn.js";
import { useUiLabel } from "./ui-labels.js";

const SIZES = { sm: "size-4", md: "size-6", lg: "size-8" } as const;

export interface SpinnerProps extends Omit<React.ComponentProps<"span">, "children"> {
  size?: keyof typeof SIZES;
  /** Screen-reader text; defaults to `UiLabelsProvider`'s `loading`. */
  label?: string;
}

export function Spinner({ size = "md", label, className, ...props }: SpinnerProps) {
  const text = useUiLabel("loading", label);
  return (
    <span
      data-slot="spinner"
      role="status"
      className={cn("inline-flex items-center justify-center", className)}
      {...props}
    >
      <Loader2Icon aria-hidden="true" className={cn("animate-spin", SIZES[size])} />
      <span className="sr-only">{text}</span>
    </span>
  );
}
