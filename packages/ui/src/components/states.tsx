import type * as React from "react";
import { cn } from "../lib/cn.js";
import { Button } from "./button.js";
import { Skeleton } from "./skeleton.js";
import { useUiLabel } from "./ui-labels.js";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div aria-hidden="true" className="text-muted-foreground [&_svg]:size-8">
          {icon}
        </div>
      ) : null}
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  requestId?: string | undefined;
  requestIdLabel?: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: React.ReactNode;
  className?: string;
}

export function ErrorState({
  title,
  description,
  requestId,
  requestIdLabel,
  onRetry,
  retryLabel,
  className,
}: ErrorStateProps) {
  const requestIdText = useUiLabel("requestId", requestIdLabel);
  const retryText = useUiLabel("retry", retryLabel);
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40 px-6 py-12 text-center",
        className,
      )}
    >
      <h2 className="text-base font-semibold text-destructive">{title}</h2>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      ) : null}
      {requestId ? (
        <p className="text-xs text-muted-foreground">
          {requestIdText}: <code className="font-mono">{requestId}</code>
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-2">
          {retryText}
        </Button>
      ) : null}
    </div>
  );
}

export interface LoadingStateProps {
  label?: string;
  lines?: number;
  className?: string;
}

export function LoadingState({ label, lines = 3, className }: LoadingStateProps) {
  const text = useUiLabel("loading", label);
  return (
    <div
      data-slot="loading-state"
      aria-busy="true"
      role="status"
      className={cn("flex flex-col gap-3", className)}
    >
      <span className="sr-only">{text}</span>
      <Skeleton className="h-6 w-1/3" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={String(i)} className={cn("h-4", i % 3 === 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
