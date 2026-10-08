import type { FundRoomSchemas } from "@fundroom/sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, call, describeError } from "../../lib/api.js";
import { formatDate } from "../../lib/format.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";
import { ConfirmDialog, statusLabel } from "./common.js";

/*
 * Delegates (E3.2): one card for both ends — the investor's own settings page (`mode: "self"`,
 * `/access/my/delegates`) and the admin People detail (`mode: "admin"`,
 * `/access/people/{id}/delegates`). The server decides everything (policy, limit, who may add);
 * this renders its answer and says why the add form is closed when it is.
 */
type DelegateList = FundRoomSchemas["DelegateList"];
type Delegate = FundRoomSchemas["Delegate"];
export type DelegateScope = FundRoomSchemas["DelegateScope"];

export const DELEGATE_SCOPES: readonly DelegateScope[] = ["all", "data_room", "updates"];

export function delegateScopeLabel(scope: DelegateScope): string {
  switch (scope) {
    case "all":
      return m.delegate_scope_all();
    case "data_room":
      return m.delegate_scope_data_room();
    case "updates":
      return m.delegate_scope_updates();
  }
}

export const myDelegatesQuery = queryOptions({
  queryKey: ["access", "my-delegates"],
  queryFn: () => call(api().GET("/access/my/delegates")),
});

export function personDelegatesQuery(id: string) {
  return queryOptions({
    queryKey: ["access", "person-delegates", id],
    queryFn: () => call(api().GET("/access/people/{id}/delegates", { params: { path: { id } } })),
  });
}

export type DelegatesCardProps =
  | { readonly mode: "self" }
  | { readonly mode: "admin"; readonly principalId: string; readonly canManage: boolean };

export function DelegatesCard(props: DelegatesCardProps) {
  const query = useQuery(
    props.mode === "self" ? myDelegatesQuery : personDelegatesQuery(props.principalId),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.delegates_title()}</CardTitle>
        <CardDescription>
          {props.mode === "self" ? m.delegates_subtitle_self() : m.delegates_subtitle_admin()}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isPending ? (
          <LoadingState label={m.common_loading()} />
        ) : query.isError ? (
          <ErrorAlert error={query.error} />
        ) : (
          <DelegatesBody props={props} data={query.data} />
        )}
      </CardContent>
    </Card>
  );
}

function DelegatesBody({ props, data }: { props: DelegatesCardProps; data: DelegateList }) {
  const canAct = props.mode === "self" ? data.selfService : props.canManage;
  const full = data.delegates.length >= data.limit;
  return (
    <>
      {data.delegates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.delegates_empty()}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.delegates_col_person()}</TableHead>
              <TableHead>{m.delegates_col_scope()}</TableHead>
              <TableHead>{m.delegates_col_status()}</TableHead>
              {canAct ? (
                <TableHead>
                  <span className="sr-only">{m.delegates_col_actions()}</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.delegates.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <div className="font-medium">{d.displayName || d.email || "—"}</div>
                  {d.displayName && d.email ? (
                    <div className="text-xs text-muted-foreground">{d.email}</div>
                  ) : null}
                </TableCell>
                <TableCell>{delegateScopeLabel(d.scope)}</TableCell>
                <TableCell>
                  {d.kind === "invite" ? (
                    <Badge variant="secondary">
                      {d.expiresAt
                        ? m.delegates_pending_until({ when: formatDate(d.expiresAt) })
                        : m.delegates_pending()}
                    </Badge>
                  ) : (
                    <Badge variant={d.status === "active" ? "success" : "outline"}>
                      {statusLabel(d.status)}
                    </Badge>
                  )}
                </TableCell>
                {canAct ? (
                  <TableCell className="text-right">
                    <RemoveDelegate props={props} delegate={d} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {!canAct ? (
        <p className="text-sm text-muted-foreground">
          {props.mode === "self" ? m.delegates_disabled_self() : m.delegates_read_only()}
        </p>
      ) : full ? (
        <p className="text-sm text-muted-foreground">
          {m.delegates_limit_reached({ limit: String(data.limit) })}
        </p>
      ) : (
        <AddDelegateForm props={props} limit={data.limit} used={data.delegates.length} />
      )}
    </>
  );
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: ["access"] });
}

function RemoveDelegate({ props, delegate }: { props: DelegatesCardProps; delegate: Delegate }) {
  const queryClient = useQueryClient();
  const name = delegate.displayName || delegate.email || "—";
  const remove = useGuardedMutation({
    mutationFn: () =>
      props.mode === "self"
        ? call(api().DELETE("/access/my/delegates/{id}", { params: { path: { id: delegate.id } } }))
        : call(
            api().DELETE("/access/people/{id}/delegates/{delegateId}", {
              params: { path: { id: props.principalId, delegateId: delegate.id } },
            }),
          ),
    onSuccess: () => {
      toast.success(m.delegates_removed({ name }));
      void invalidate(queryClient);
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="ghost" size="sm">
          {m.delegates_remove()}
          <span className="sr-only"> {name}</span>
        </Button>
      }
      title={m.delegates_remove_title({ name })}
      description={
        delegate.kind === "invite"
          ? m.delegates_remove_invite_body()
          : m.delegates_remove_member_body()
      }
      confirmLabel={m.delegates_remove()}
      onConfirm={() => remove.mutate()}
      pending={remove.isPending}
    />
  );
}

function AddDelegateForm({
  props,
  limit,
  used,
}: {
  props: DelegatesCardProps;
  limit: number;
  used: number;
}) {
  const ids = { email: useId(), name: useId(), scope: useId() };
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<DelegateScope>("all");
  const queryClient = useQueryClient();
  const add = useGuardedMutation({
    mutationFn: async (): Promise<void> => {
      const body = {
        email: email.trim(),
        scope,
        ...(name.trim() ? { displayName: name.trim() } : {}),
      };
      if (props.mode === "self") await call(api().POST("/access/my/delegates", { body }));
      else
        await call(
          api().POST("/access/people/{id}/delegates", {
            params: { path: { id: props.principalId } },
            body,
          }),
        );
    },
    onSuccess: () => {
      // Self-service answers "sent" for every address (F1), so the toast does not claim more.
      toast.success(
        props.mode === "self"
          ? m.delegates_requested({ email: email.trim() })
          : m.delegates_added({ email: email.trim() }),
      );
      setEmail("");
      setName("");
      setScope("all");
      void invalidate(queryClient);
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (email.trim()) add.mutate();
  }
  return (
    <form className="space-y-4" onSubmit={submit} aria-labelledby={`${ids.scope}-heading`}>
      <h3 id={`${ids.scope}-heading`} className="font-medium">
        {m.delegates_add_title()}
      </h3>
      <p className="text-sm text-muted-foreground">
        {m.delegates_remaining({ left: String(limit - used), limit: String(limit) })}
      </p>
      {add.isError ? <ErrorAlert error={add.error} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={ids.email} label={m.delegates_email()} required>
          <Input
            id={ids.email}
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field id={ids.name} label={m.delegates_name()}>
          <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{m.delegates_scope_legend()}</legend>
        <div className="flex flex-wrap gap-4">
          {DELEGATE_SCOPES.map((s) => (
            <label
              key={s}
              htmlFor={`${ids.scope}-${s}`}
              className="flex items-center gap-2 text-sm"
            >
              <input
                id={`${ids.scope}-${s}`}
                type="radio"
                name={`delegate-scope-${ids.scope}`}
                value={s}
                checked={scope === s}
                onChange={() => setScope(s)}
              />
              {delegateScopeLabel(s)}
            </label>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{m.delegates_scope_hint()}</p>
      </fieldset>
      <Button type="submit" loading={add.isPending} disabled={!email.trim()}>
        {m.delegates_add()}
      </Button>
    </form>
  );
}
