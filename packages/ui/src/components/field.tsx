import type * as React from "react";
import { cn } from "../lib/cn.js";
import { Label } from "./label.js";

export interface FieldProps {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

/** Pair the control with `fieldAria(id, { description, error })` so it references these ids. */
export function fieldAria(
  id: string,
  present: { description?: boolean; error?: boolean },
): { "aria-describedby"?: string; "aria-invalid"?: true } {
  const ids: string[] = [];
  if (present.error) ids.push(`${id}-error`);
  if (present.description) ids.push(`${id}-description`);
  return {
    ...(ids.length > 0 ? { "aria-describedby": ids.join(" ") } : {}),
    ...(present.error ? { "aria-invalid": true as const } : {}),
  };
}

export function Field({
  id,
  label,
  description,
  error,
  required,
  children,
  className,
}: FieldProps) {
  return (
    <div data-slot="field" className={cn("grid gap-2", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {description ? (
        <p
          id={`${id}-description`}
          data-slot="field-description"
          className="text-sm text-muted-foreground"
        >
          {description}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          data-slot="field-error"
          className="text-sm font-medium text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
