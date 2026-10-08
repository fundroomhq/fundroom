import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  LoadingState,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { KeyRound, ShieldOff } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ErrorAlert } from "../components/error-alert.js";
import { PlatformShell } from "../components/platform/platform-shell.js";
import { authRedirectFor, isCode } from "../lib/api.js";
import {
  PLATFORM_KEY,
  PLATFORM_ME_KEY,
  platformMeQuery,
  startOperatorSession,
} from "../lib/platform-queries.js";
import { m } from "../paraglide/messages.js";

/*
 * The operator console (E3.10, ADR-0058), on the canonical host only. The server serves this
 * SPA for `/platform/*` there, but every API behind it answers a plain 404 to anyone without a
 * live operator session — including when the control plane is off — so this layout cannot tell
 * "not an operator" from "not signed in to the console yet", and does not try: a 404 on
 * `/platform/me` shows the sign-in gate, and only the gate's own `POST /platform/session`
 * learns which it was.
 *
 * The operator session is a SEPARATE session (`__Host-op_sid`), minted from an ordinary
 * canonical-host session that is at auth level 2 and fresh. When that session is missing, weak
 * or stale, the gate sends the operator through the normal login or step-up screen and back
 * here (`returnTo`), then they press the button again: the mint is never automatic, so a
 * redirect loop is impossible and every operator session starts with a deliberate action.
 */
export const Route = createFileRoute("/platform")({ component: PlatformLayout });

function PlatformLayout() {
  const me = useQuery(platformMeQuery);
  useOperatorSessionWatch();
  if (me.isPending) return <LoadingState label={m.common_loading()} />;
  if (me.isError) {
    if (isCode(me.error, "not_found")) return <OperatorGate />;
    return (
      <GateFrame>
        <ErrorAlert error={me.error} />
      </GateFrame>
    );
  }
  return (
    <PlatformShell me={me.data}>
      <Outlet />
    </PlatformShell>
  );
}

/**
 * An operator session ends on its own (1 h idle, 12 h absolute, a revoked operator row, a CIDR
 * change) and the server then answers every console call with 404. So a 404 from any console
 * query re-reads `/platform/me`: if the session is gone, the layout falls back to the gate; if
 * it is not (a workspace id that does not exist), nothing changes.
 */
function useOperatorSessionWatch() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error") return;
        const key = event.query.queryKey;
        if (key[0] !== PLATFORM_KEY[0] || key[1] === PLATFORM_ME_KEY[1]) return;
        if (isCode(event.action.error, "not_found")) {
          void queryClient.invalidateQueries({ queryKey: PLATFORM_ME_KEY });
        }
      }),
    [queryClient],
  );
}

function GateFrame({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="flex min-h-svh items-start justify-center bg-muted/30 p-4 sm:p-8">
      <div className="w-full max-w-md space-y-4 pt-8">{children}</div>
    </main>
  );
}

function OperatorGate() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  const [unavailable, setUnavailable] = useState(false);
  const start = useMutation({
    mutationFn: startOperatorSession,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PLATFORM_ME_KEY }),
    onError: (error) => {
      // Not signed in → login; signed in but not level 2 or not fresh → step-up. Both come
      // back to where the operator was, and the button is pressed again.
      const redirect = authRedirectFor(error, href);
      if (redirect !== undefined) {
        void navigate(redirect);
        return;
      }
      // The server's single answer for "not an operator", "not from an allowed network" and
      // "no control plane here": nothing to retry, so the button goes away.
      if (isCode(error, "not_found")) setUnavailable(true);
    },
  });
  if (unavailable) {
    return (
      <GateFrame>
        <Alert variant="destructive" role="alert">
          <ShieldOff aria-hidden="true" />
          <AlertTitle>{m.platform_unavailable_title()}</AlertTitle>
          <AlertDescription>{m.platform_unavailable_body()}</AlertDescription>
        </Alert>
      </GateFrame>
    );
  }
  return (
    <GateFrame>
      <Card>
        <CardHeader>
          <h1 className="text-xl font-semibold tracking-tight">{m.platform_gate_title()}</h1>
          <CardDescription>{m.platform_gate_body()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {start.isError && !isCode(start.error, "not_found") ? (
            <ErrorAlert error={start.error} />
          ) : null}
          <Button
            type="button"
            className="w-full"
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            <KeyRound aria-hidden="true" />
            {m.platform_gate_start()}
          </Button>
          <p className="text-sm text-muted-foreground">{m.platform_gate_note()}</p>
        </CardContent>
      </Card>
    </GateFrame>
  );
}
