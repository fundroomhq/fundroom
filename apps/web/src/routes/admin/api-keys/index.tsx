import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  fieldAria,
  Input,
  Label,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Plus, ShieldOff } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../../components/access/common.js";
import {
  PlanChangeHint,
  PlanFeatureNotice,
  usePlanAllowsFeature,
} from "../../../components/billing/plan-feature-notice.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { ShownOnce } from "../../../components/shown-once.js";
import { api, call, isPlanEntitlementRefusal } from "../../../lib/api.js";
import {
  API_KEY_DEFAULT_GRACE_HOURS,
  API_KEY_GRACE_HOURS,
  API_KEYS_KEY,
  type ApiKey,
  apiKeyScopesQuery,
  apiKeyStatusLabel,
  apiKeyStatusVariant,
  apiKeysQuery,
  describeApiKeyError,
  graceLabel,
  groupScopes,
  revokedReasonLabel,
} from "../../../lib/api-keys-queries.js";
import { formatDateTime } from "../../../lib/format.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/api-keys/")({ component: ApiKeysPage });

/*
 * API keys (E3.4, ADR-0052). A kernel screen: keys authenticate requests before any module is
 * resolved, so no module could own them.
 *
 * What the admin needs from it:
 *
 *  - **The token exists once.** Create and rotate are the only responses that carry it; the
 *    server keeps a sha256. It is pinned at the top of the page until dismissed. A step-up round
 *    trip reloads the page, which is why the mutation response is the only place it comes from.
 *  - **A key is its creator, capped.** Scopes the admin does not hold themselves are shown but
 *    cannot be ticked, with the reason beside them, and a key whose creator lost their role stops
 *    working — the list says so ("creator no longer has access") rather than just "revoked".
 */
function ApiKeysPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("api-keys.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.apikeys_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <ApiKeysScreen canManage={permissions.includes("api-keys.manage")} />;
}

interface Revealed {
  title: string;
  token: string;
}

function ApiKeysScreen({ canManage }: { canManage: boolean }) {
  const list = useInfiniteQuery(apiKeysQuery());
  const [revealed, setRevealed] = useState<Revealed>();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.apikeys_title()}
        description={m.apikeys_subtitle()}
        actions={canManage ? <CreateKeyDialog onCreated={setRevealed} /> : null}
      />
      <PlanFeatureNotice feature="api_keys" />
      {revealed ? (
        <ShownOnce
          title={revealed.title}
          value={revealed.token}
          copyLabel={m.apikeys_copy_token()}
          onDismiss={() => setRevealed(undefined)}
        >
          <p>{m.apikeys_token_usage()}</p>
        </ShownOnce>
      ) : null}
      {canManage ? null : <p className="text-sm text-muted-foreground">{m.apikeys_read_only()}</p>}
      {list.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {list.isError ? <ErrorAlert error={list.error} /> : null}
      {list.data ? (
        items.length === 0 ? (
          <EmptyState
            icon={<KeyRound aria-hidden="true" />}
            title={m.apikeys_empty_title()}
            description={m.apikeys_empty_body()}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table aria-label={m.apikeys_title()}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.apikeys_col_name()}</TableHead>
                    <TableHead>{m.apikeys_col_status()}</TableHead>
                    <TableHead>{m.apikeys_col_prefix()}</TableHead>
                    <TableHead>{m.apikeys_col_scopes()}</TableHead>
                    <TableHead>{m.apikeys_col_creator()}</TableHead>
                    <TableHead>{m.apikeys_col_created()}</TableHead>
                    <TableHead>{m.apikeys_col_expires()}</TableHead>
                    <TableHead>{m.apikeys_col_last_used()}</TableHead>
                    {canManage ? (
                      <TableHead>
                        <span className="sr-only">{m.common_actions()}</span>
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((key) => (
                    <KeyRow
                      key={key.id}
                      apiKey={key}
                      canManage={canManage}
                      onRotated={setRevealed}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            {list.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {m.common_load_more()}
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

function KeyRow({
  apiKey,
  canManage,
  onRotated,
}: {
  apiKey: ApiKey;
  canManage: boolean;
  onRotated: (revealed: Revealed) => void;
}) {
  const queryClient = useQueryClient();
  const revoke = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/api-keys/{id}/revoke", { params: { path: { id: apiKey.id } } })),
    onSuccess: () => {
      toast.success(m.apikeys_revoked_ok({ name: apiKey.name }));
      void queryClient.invalidateQueries({ queryKey: API_KEYS_KEY });
    },
    onError: (error) => toast.error(describeApiKeyError(error)),
  });
  return (
    <TableRow>
      <TableCell className="font-medium">
        <div>{apiKey.name}</div>
        {apiKey.note ? (
          <div className="text-xs font-normal text-muted-foreground">{apiKey.note}</div>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge variant={apiKeyStatusVariant(apiKey.status)}>
          {apiKeyStatusLabel(apiKey.status)}
        </Badge>
        {apiKey.revokedReason !== null && apiKey.revokedReason !== "revoked" ? (
          <div className="mt-1 text-xs text-muted-foreground">
            {revokedReasonLabel(apiKey.revokedReason)}
          </div>
        ) : apiKey.revokedReason === null && apiKey.replacedById !== null ? (
          // Rotated with a grace window: it keeps working until `expiresAt`, then expires.
          <div className="mt-1 text-xs text-muted-foreground">{m.apikeys_replaced()}</div>
        ) : null}
      </TableCell>
      <TableCell>
        <code className="font-mono text-xs">{apiKey.prefix}</code>
      </TableCell>
      <TableCell>
        <ul className="flex max-w-xs flex-wrap gap-1">
          {apiKey.scopes.map((scope) => (
            <li key={scope}>
              <code className="rounded bg-muted px-1 font-mono text-xs">{scope}</code>
            </li>
          ))}
        </ul>
      </TableCell>
      <TableCell>{apiKey.createdBy.displayName ?? m.apikeys_creator_unknown()}</TableCell>
      <TableCell>{formatDateTime(apiKey.createdAt)}</TableCell>
      <TableCell>
        {apiKey.expiresAt === null ? m.apikeys_never_expires() : formatDateTime(apiKey.expiresAt)}
      </TableCell>
      <TableCell>
        {apiKey.lastUsedAt === null ? m.apikeys_never_used() : formatDateTime(apiKey.lastUsedAt)}
      </TableCell>
      {canManage ? (
        <TableCell className="text-right">
          {apiKey.status === "revoked" ? null : (
            <div className="flex justify-end gap-1">
              <EditKeyDialog apiKey={apiKey} />
              {apiKey.status === "live" ? (
                <RotateKeyDialog apiKey={apiKey} onRotated={onRotated} />
              ) : null}
              <ConfirmDialog
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending}
                    aria-label={m.apikeys_revoke_named({ name: apiKey.name })}
                  >
                    {m.apikeys_revoke()}
                  </Button>
                }
                title={m.apikeys_revoke_title({ name: apiKey.name })}
                description={m.apikeys_revoke_body()}
                confirmLabel={m.apikeys_revoke()}
                pending={revoke.isPending}
                onConfirm={() => revoke.mutate()}
              />
            </div>
          )}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/** `YYYY-MM-DD` from a date input → the end of that day, local time, as an ISO instant. */
function endOfDay(date: string): string {
  return new Date(`${date}T23:59:59`).toISOString();
}

function todayInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function CreateKeyDialog({ onCreated }: { onCreated: (revealed: Revealed) => void }) {
  const queryClient = useQueryClient();
  // A-3: existing keys keep working and can be rotated, renamed and revoked; only a new key
  // needs `api_keys` on the plan.
  const planAllows = usePlanAllowsFeature("api_keys");
  const [open, setOpen] = useState(false);
  const scopes = useQuery({ ...apiKeyScopesQuery, enabled: open });
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [note, setNote] = useState("");
  const ids = { name: useId(), expiresAt: useId(), note: useId(), scopes: useId() };

  const reset = () => {
    setName("");
    setPicked([]);
    setExpiresAt("");
    setNote("");
  };

  const create = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/api-keys", {
          body: {
            name: name.trim(),
            scopes: [...picked],
            ...(expiresAt === "" ? {} : { expiresAt: endOfDay(expiresAt) }),
            ...(note.trim() === "" ? {} : { note: note.trim() }),
          },
        }),
      ),
    onSuccess: (result) => {
      onCreated({ title: m.apikeys_created_title({ name: result.key.name }), token: result.token });
      toast.success(m.apikeys_created_ok());
      void queryClient.invalidateQueries({ queryKey: API_KEYS_KEY });
      reset();
      setOpen(false);
    },
  });

  const canSubmit = name.trim() !== "" && picked.length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" disabled={!planAllows}>
          <Plus aria-hidden="true" />
          {m.apikeys_create()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.apikeys_create_title()}</DialogTitle>
            <DialogDescription>{m.apikeys_create_body()}</DialogDescription>
          </DialogHeader>
          {create.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{m.apikeys_create_failed()}</AlertTitle>
              <AlertDescription>
                <p>{describeApiKeyError(create.error)}</p>
                {isPlanEntitlementRefusal(create.error) ? <PlanChangeHint /> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <Field id={ids.name} label={m.apikeys_field_name()} required>
            <Input
              id={ids.name}
              value={name}
              required
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <fieldset className="space-y-3" aria-describedby={`${ids.scopes}-hint`}>
            <legend className="text-sm font-medium">{m.apikeys_field_scopes()}</legend>
            <p id={`${ids.scopes}-hint`} className="text-sm text-muted-foreground">
              {m.apikeys_field_scopes_hint()}
            </p>
            {scopes.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
            {scopes.isError ? <ErrorAlert error={scopes.error} /> : null}
            {scopes.data
              ? groupScopes(scopes.data.scopes).map(({ group, scopes: list }) => (
                  <fieldset key={group} className="space-y-2 rounded-md border p-3">
                    <legend className="px-1 font-mono text-xs">{group}</legend>
                    {list.map((scope) => {
                      const boxId = `${ids.scopes}-${scope.id}`;
                      return (
                        <div key={scope.id} className="flex items-start gap-2">
                          <Checkbox
                            id={boxId}
                            className="mt-0.5"
                            disabled={!scope.held}
                            checked={picked.includes(scope.id)}
                            aria-describedby={`${boxId}-desc`}
                            onCheckedChange={(on) =>
                              setPicked((cur) =>
                                on === true
                                  ? [...cur, scope.id]
                                  : cur.filter((s) => s !== scope.id),
                              )
                            }
                          />
                          <div className="grid gap-0.5">
                            <Label htmlFor={boxId} className="font-mono text-xs">
                              {scope.id}
                            </Label>
                            <p id={`${boxId}-desc`} className="text-xs text-muted-foreground">
                              {scope.description}
                              {scope.held ? null : (
                                <>
                                  {" "}
                                  <span className="font-medium">{m.apikeys_scope_not_held()}</span>
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </fieldset>
                ))
              : null}
          </fieldset>
          <Field
            id={ids.expiresAt}
            label={m.apikeys_field_expires()}
            description={m.apikeys_field_expires_hint()}
          >
            <Input
              id={ids.expiresAt}
              type="date"
              min={todayInput()}
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              {...fieldAria(ids.expiresAt, { description: true })}
            />
          </Field>
          <Field id={ids.note} label={m.apikeys_field_note()} description={m.apikeys_note_hint()}>
            <Textarea
              id={ids.note}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              {...fieldAria(ids.note, { description: true })}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={create.isPending} disabled={!canSubmit}>
              {m.apikeys_create_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateKeyDialog({
  apiKey,
  onRotated,
}: {
  apiKey: ApiKey;
  onRotated: (revealed: Revealed) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [grace, setGrace] = useState(API_KEY_DEFAULT_GRACE_HOURS);
  const graceId = useId();
  const rotate = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/api-keys/{id}/rotate", {
          params: { path: { id: apiKey.id } },
          body: { graceHours: grace },
        }),
      ),
    onSuccess: (result) => {
      onRotated({ title: m.apikeys_rotated_title({ name: result.key.name }), token: result.token });
      toast.success(m.apikeys_rotated_ok());
      void queryClient.invalidateQueries({ queryKey: API_KEYS_KEY });
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) rotate.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={m.apikeys_rotate_named({ name: apiKey.name })}
        >
          {m.apikeys_rotate()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            rotate.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.apikeys_rotate_title({ name: apiKey.name })}</DialogTitle>
            <DialogDescription>{m.apikeys_rotate_body()}</DialogDescription>
          </DialogHeader>
          {rotate.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{m.apikeys_rotate_failed()}</AlertTitle>
              <AlertDescription>{describeApiKeyError(rotate.error)}</AlertDescription>
            </Alert>
          ) : null}
          <Field id={graceId} label={m.apikeys_grace()} description={m.apikeys_grace_hint()}>
            <NativeSelect
              id={graceId}
              value={String(grace)}
              onChange={(e) => setGrace(Number(e.target.value))}
              {...fieldAria(graceId, { description: true })}
            >
              {API_KEY_GRACE_HOURS.map((h) => (
                <option key={h} value={String(h)}>
                  {graceLabel(h)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={rotate.isPending}>
              {m.apikeys_rotate_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditKeyDialog({ apiKey }: { apiKey: ApiKey }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(apiKey.name);
  const [note, setNote] = useState(apiKey.note ?? "");
  const ids = { name: useId(), note: useId() };
  const update = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/api-keys/{id}", {
          params: { path: { id: apiKey.id } },
          body: { name: name.trim(), note: note.trim() === "" ? null : note.trim() },
        }),
      ),
    onSuccess: () => {
      toast.success(m.apikeys_updated_ok());
      void queryClient.invalidateQueries({ queryKey: API_KEYS_KEY });
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(apiKey.name);
          setNote(apiKey.note ?? "");
        } else update.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={m.apikeys_edit_named({ name: apiKey.name })}
        >
          {m.apikeys_edit()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (name.trim() !== "") update.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.apikeys_edit_title({ name: apiKey.name })}</DialogTitle>
            <DialogDescription>{m.apikeys_edit_body()}</DialogDescription>
          </DialogHeader>
          {update.isError ? <ErrorAlert error={update.error} /> : null}
          <Field id={ids.name} label={m.apikeys_field_name()} required>
            <Input
              id={ids.name}
              value={name}
              required
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field id={ids.note} label={m.apikeys_field_note()}>
            <Textarea
              id={ids.note}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={update.isPending} disabled={name.trim() === ""}>
              {m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
