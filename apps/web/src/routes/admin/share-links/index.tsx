import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog, capabilityLabel } from "../../../components/access/common.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { CopyButton } from "../../../components/copy-button.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { dataRoomTreeQuery } from "../../../lib/data-room-queries.js";
import { formatDate, formatDateTime } from "../../../lib/format.js";
import { groupsQuery, useBootstrap } from "../../../lib/queries.js";
import {
  describeShareLinkError,
  type InviteGrant,
  isExhausted,
  SHARE_LINKS_KEY,
  type ShareLink,
  type ShareLinkCreated,
  shareLinkErrorReason,
  shareLinkStatusLabel,
  shareLinkStatusVariant,
  shareLinksQuery,
  shareLinkVisitsQuery,
  splitList,
} from "../../../lib/share-links-queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/share-links/")({ component: ShareLinksPage });

type Capability = InviteGrant["capabilities"][number];
type TargetResource = InviteGrant["resource"];

const CAPABILITIES = [
  "view",
  "download",
  "comment",
  "edit",
] as const satisfies readonly Capability[];

/*
 * Share links (E2.3, EXECUTION_PLAN §9.3, design/05 §5, ADR-0041). A kernel screen, for the same
 * reason the routes are kernel: a link mints a `core.membership` and writes a `core.access_grant`
 * whose subject is the link itself, and neither of those is a module's to own.
 *
 * Three things this screen owes the admin, none of them decoration:
 *
 *  - **The token exists once.** `POST /links` is the only time the plaintext is on the wire; the
 *    column holds its sha256 and nothing can show it again. So the minted URL is pinned on screen
 *    until it is dismissed, with copying one click away, and the copy says plainly that leaving
 *    the page loses it.
 *  - **Pause is not "stop admitting people".** `PrincipalRepo` emits no subject for a paused
 *    link, so pausing suspends access for everybody it has *already* admitted (contract A6). An
 *    admin who reads "paused" as "no new visitors" will cut off the room mid-diligence.
 *  - **Revoking a link does not revoke its memberships** unless the admin asks, and asking is a
 *    different, larger decision than revoking the link. Both options are spelled out in the
 *    confirmation rather than hidden behind a single "are you sure?".
 *
 * The 506(b) audience rule is the **server's**, and this screen renders its refusal. Re-deriving
 * "a 506(b) link must name its audience" in the browser would put a securities rule in a language
 * that cannot see the workspace's offering period, and the two copies would drift.
 */
function ShareLinksPage() {
  const bootstrap = useBootstrap();
  const canManage = (bootstrap.data?.permissions ?? []).includes("share-links.manage");
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const links = useQuery(shareLinksQuery(includeRevoked));
  const revokedId = useId();
  return (
    <div className="space-y-6">
      <PageHeader title={m.share_links_title()} description={m.share_links_subtitle()} />
      {links.isPending ? <LoadingState lines={5} label={m.common_loading()} /> : null}
      {links.isError ? <ErrorAlert error={links.error} /> : null}
      {links.data ? (
        <>
          <div className="flex items-center gap-2">
            <Checkbox
              id={revokedId}
              checked={includeRevoked}
              onCheckedChange={(on) => setIncludeRevoked(on === true)}
            />
            <Label htmlFor={revokedId}>{m.share_links_show_revoked()}</Label>
          </div>
          {links.data.links.length === 0 ? (
            <EmptyState
              icon={<Link2 />}
              title={m.share_links_none_title()}
              description={m.share_links_none_body()}
            />
          ) : (
            <ul className="space-y-4">
              {links.data.links.map((link) => (
                <li key={link.id}>
                  <LinkCard link={link} canManage={canManage} />
                </li>
              ))}
            </ul>
          )}
          {canManage ? <CreateLinkCard /> : null}
        </>
      ) : null}
    </div>
  );
}

function Counter({ label, used, cap }: { label: string; used: number; cap: number | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {cap === null
          ? m.share_links_count_uncapped({ used: String(used) })
          : m.share_links_count_capped({ used: String(used), cap: String(cap) })}
      </dd>
    </div>
  );
}

function LinkCard({ link, canManage }: { link: ShareLink; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [showVisits, setShowVisits] = useState(false);
  const [revokeMemberships, setRevokeMemberships] = useState(false);
  const revokeBoxId = useId();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: SHARE_LINKS_KEY });

  const setPaused = useGuardedMutation<unknown, boolean>({
    mutationFn: (paused) =>
      call(
        paused
          ? api().POST("/links/{id}/pause", { params: { path: { id: link.id } } })
          : api().POST("/links/{id}/resume", { params: { path: { id: link.id } } }),
      ),
    onSuccess: (_data, paused) => {
      void invalidate();
      toast.success(paused ? m.share_links_paused_ok() : m.share_links_resumed_ok());
    },
    onError: (error) => toast.error(describeShareLinkError(error)),
  });

  const revoke = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/links/{id}/revoke", {
          params: { path: { id: link.id } },
          body: { revokeMemberships },
        }),
      ),
    onSuccess: () => {
      void invalidate();
      toast.success(
        revokeMemberships ? m.share_links_revoked_all_ok() : m.share_links_revoked_ok(),
      );
    },
    onError: (error) => toast.error(describeShareLinkError(error)),
  });

  const audience =
    link.policy.emails.length > 0
      ? m.share_links_audience_emails({ count: link.policy.emails.length })
      : link.policy.domains.length > 0
        ? link.policy.domains.join(", ")
        : m.share_links_audience_any();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="break-all">{link.label}</span>
          <Badge variant={shareLinkStatusVariant(link.status)}>
            {shareLinkStatusLabel(link.status)}
          </Badge>
          {link.passcodeRequired ? (
            <Badge variant="outline">{m.share_links_passcode()}</Badge>
          ) : null}
          <span className="text-xs font-normal text-muted-foreground">
            {m.share_links_created({ when: formatDateTime(link.createdAt) })}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {link.status === "paused" ? (
          <Alert variant="warning">
            <AlertTitle>{m.share_links_paused_title()}</AlertTitle>
            <AlertDescription>{m.share_links_paused_body()}</AlertDescription>
          </Alert>
        ) : null}
        {link.status === "active" && isExhausted(link) ? (
          <Alert>
            <AlertTitle>{m.share_links_exhausted_title()}</AlertTitle>
            <AlertDescription>{m.share_links_exhausted_body()}</AlertDescription>
          </Alert>
        ) : null}
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Counter label={m.share_links_uses()} used={link.uses} cap={link.maxUses} />
          <Counter label={m.share_links_views()} used={link.views} cap={link.maxViews} />
          <div>
            <dt className="text-xs text-muted-foreground">{m.share_links_audience()}</dt>
            <dd className="break-words">{audience}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{m.share_links_expiry()}</dt>
            <dd>
              {link.expiresAt === null ? m.share_links_no_expiry() : formatDate(link.expiresAt)}
            </dd>
          </div>
        </dl>
        {link.grants.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {m.share_links_grants({
              count: link.grants.length,
              capabilities: [...new Set(link.grants.flatMap((g) => g.capabilities))]
                .map(capabilityLabel)
                .join(", "),
            })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{m.share_links_no_grants()}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={showVisits}
            onClick={() => setShowVisits((v) => !v)}
          >
            {m.share_links_visits({ count: String(link.visits) })}
          </Button>
          {canManage && link.status !== "revoked" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={setPaused.isPending}
                onClick={() => setPaused.mutate(link.status === "active")}
              >
                {link.status === "active" ? m.share_links_pause() : m.share_links_resume()}
              </Button>
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="outline" size="sm" disabled={revoke.isPending}>
                    {m.share_links_revoke()}
                  </Button>
                }
                title={m.share_links_revoke_title({ label: link.label })}
                description={m.share_links_revoke_body()}
                confirmLabel={m.share_links_revoke()}
                pending={revoke.isPending}
                onConfirm={() => revoke.mutate()}
              >
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id={revokeBoxId}
                      checked={revokeMemberships}
                      onCheckedChange={(on) => setRevokeMemberships(on === true)}
                    />
                    <Label htmlFor={revokeBoxId} className="leading-snug">
                      {m.share_links_revoke_memberships()}
                    </Label>
                  </div>
                  {/* Both halves of the choice, because the default is the quieter one and the
                      loud one cannot be undone. */}
                  <p className="text-sm text-muted-foreground">
                    {revokeMemberships
                      ? m.share_links_revoke_memberships_on()
                      : m.share_links_revoke_memberships_off()}
                  </p>
                </div>
              </ConfirmDialog>
            </>
          ) : null}
        </div>
        {showVisits ? <Visits linkId={link.id} /> : null}
      </CardContent>
    </Card>
  );
}

/** Who came in through this link. A membership here is a real member, not a guest session. */
function Visits({ linkId }: { linkId: string }) {
  const visits = useQuery(shareLinkVisitsQuery(linkId, true));
  if (visits.isPending) return <LoadingState lines={2} label={m.common_loading()} />;
  if (visits.isError) return <ErrorAlert error={visits.error} />;
  if (visits.data.visits.length === 0)
    return <p className="text-sm text-muted-foreground">{m.share_links_visits_none()}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{m.share_links_visit_who()}</TableHead>
          <TableHead>{m.share_links_visit_first()}</TableHead>
          <TableHead>{m.share_links_visit_last()}</TableHead>
          <TableHead>{m.share_links_views()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visits.data.visits.map((visit) => (
          <TableRow key={visit.membershipId}>
            <TableCell>
              {visit.displayName}
              {visit.email === null ? null : (
                <div className="text-xs text-muted-foreground">{visit.email}</div>
              )}
              {visit.revokedAt === null ? null : (
                <Badge variant="destructive">{m.share_links_status_revoked()}</Badge>
              )}
            </TableCell>
            <TableCell>{formatDateTime(visit.firstSeenAt)}</TableCell>
            <TableCell>{formatDateTime(visit.lastSeenAt)}</TableCell>
            <TableCell className="tabular-nums">{visit.views}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The minted link. Shown once; the server cannot show it again. */
function MintedLink({ created, onDismiss }: { created: ShareLinkCreated; onDismiss: () => void }) {
  return (
    <Alert variant="success">
      <AlertTitle>{m.share_links_minted_title()}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{m.share_links_minted_body()}</p>
        <code className="block w-full overflow-x-auto rounded border bg-background p-2 font-mono text-xs break-all">
          {created.url}
        </code>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={created.url} label={m.share_links_copy()} />
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            {m.common_close()}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function CreateLinkCard() {
  const queryClient = useQueryClient();
  const bootstrap = useBootstrap();
  const groups = useQuery(groupsQuery);
  const hasDataRoom = (bootstrap.data?.modules ?? []).some(
    (mod) => mod.id === "data-room" && mod.enabled,
  );
  const tree = useQuery({ ...dataRoomTreeQuery, enabled: hasDataRoom });

  const [label, setLabel] = useState("");
  const [domains, setDomains] = useState("");
  const [emails, setEmails] = useState("");
  const [forceWatermark, setForceWatermark] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [maxViews, setMaxViews] = useState("");
  const [groupIds, setGroupIds] = useState<readonly string[]>([]);
  const [target, setTarget] = useState("");
  const [capabilities, setCapabilities] = useState<readonly Capability[]>(["view"]);
  const [created, setCreated] = useState<ShareLinkCreated>();

  const ids = {
    label: useId(),
    domains: useId(),
    emails: useId(),
    watermark: useId(),
    passcode: useId(),
    expiresAt: useId(),
    maxUses: useId(),
    maxViews: useId(),
    target: useId(),
  };

  /*
   * A share link may target any registered resource kind (contract S3), but the browser has no
   * catalogue of them. A target is sent as `{kind, id}` and nothing more: the server checks it
   * exists in this workspace and derives the rule's path itself (a folder's own, so the link
   * covers what is filed in it), and refuses a path that is not that one (review R1-A1/A2).
   * The data room is the one kind with a tree the web app can already read, so it is what
   * this picker offers; a link with no target still does useful work through its target groups,
   * which is why "no resource" is a first-class option rather than a validation error.
   */
  const targets: readonly { value: string; label: string; resource: TargetResource }[] = [
    ...(tree.data?.folders ?? []).map((f) => ({
      value: `folder:${f.id}`,
      label: f.name,
      resource: { kind: "folder", id: f.id } satisfies TargetResource,
    })),
    ...(tree.data?.documents ?? []).map((d) => ({
      value: `document:${d.id}`,
      label: d.title,
      resource: { kind: "document", id: d.id } satisfies TargetResource,
    })),
  ];

  const create = useGuardedMutation({
    mutationFn: () => {
      const picked = targets.find((t) => t.value === target);
      const grants =
        picked === undefined || capabilities.length === 0
          ? []
          : [{ resource: picked.resource, capabilities: [...capabilities] }];
      return call(
        api().POST("/links", {
          body: {
            label: label.trim(),
            policy: {
              domains: splitList(domains).map((d) => d.toLowerCase().replace(/^@/u, "")),
              emails: splitList(emails),
              forceWatermark,
            },
            grants,
            groupIds: [...groupIds],
            ...(passcode.trim() === "" ? {} : { passcode: passcode.trim() }),
            ...(expiresAt === "" ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
            ...(maxUses === "" ? {} : { maxUses: Number(maxUses) }),
            ...(maxViews === "" ? {} : { maxViews: Number(maxViews) }),
          },
        }),
      );
    },
    onSuccess: (result) => {
      setCreated(result);
      setLabel("");
      setPasscode("");
      void queryClient.invalidateQueries({ queryKey: SHARE_LINKS_KEY });
      toast.success(m.share_links_created_ok());
    },
    // A refused *policy* is a decision about this form, so it is rendered in the form rather
    // than thrown at a toast that vanishes while the admin is still reading it.
    onError: (error) => {
      if (shareLinkErrorReason(error) === undefined) toast.error(describeError(error).body);
    },
  });

  const refusal = create.isError ? shareLinkErrorReason(create.error) : undefined;
  const audienceRefused = refusal === "audience_too_open";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.share_links_create_title()}</CardTitle>
        <CardDescription>{m.share_links_create_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {created ? <MintedLink created={created} onDismiss={() => setCreated(undefined)} /> : null}
        {refusal !== undefined && !audienceRefused ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{m.share_links_refused_title()}</AlertTitle>
            <AlertDescription>{describeShareLinkError(create.error)}</AlertDescription>
          </Alert>
        ) : null}
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (label.trim() !== "") create.mutate();
          }}
        >
          <Field
            id={ids.label}
            label={m.share_links_label()}
            description={m.share_links_label_hint()}
            required
          >
            <Input
              id={ids.label}
              value={label}
              required
              maxLength={200}
              onChange={(e) => setLabel(e.target.value)}
              {...fieldAria(ids.label, { description: true })}
            />
          </Field>
          <fieldset className="space-y-4 rounded-md border p-4">
            <legend className="px-1 text-sm font-medium">{m.share_links_audience_legend()}</legend>
            <p className="text-sm text-muted-foreground">{m.share_links_audience_help()}</p>
            <Field
              id={ids.domains}
              label={m.share_links_domains()}
              // B9: `acme.com` does NOT admit `mail.acme.com`, and an admin who expects it to
              // gets a quieter link than they meant rather than a louder one.
              description={m.share_links_domains_hint()}
              error={audienceRefused ? describeShareLinkError(create.error) : undefined}
            >
              <Textarea
                id={ids.domains}
                rows={2}
                value={domains}
                placeholder="acme.com"
                onChange={(e) => setDomains(e.target.value)}
                {...fieldAria(ids.domains, { description: true, error: audienceRefused })}
              />
            </Field>
            <Field
              id={ids.emails}
              label={m.share_links_emails()}
              description={m.share_links_emails_hint()}
            >
              <Textarea
                id={ids.emails}
                rows={2}
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                {...fieldAria(ids.emails, { description: true })}
              />
            </Field>
          </fieldset>
          <Field
            id={ids.passcode}
            label={m.share_links_passcode_field()}
            description={m.share_links_passcode_field_hint()}
          >
            <Input
              id={ids.passcode}
              type="password"
              value={passcode}
              minLength={6}
              maxLength={128}
              autoComplete="new-password"
              onChange={(e) => setPasscode(e.target.value)}
              {...fieldAria(ids.passcode, { description: true })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={ids.expiresAt} label={m.share_links_expiry()}>
              <Input
                id={ids.expiresAt}
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </Field>
            <Field
              id={ids.maxUses}
              label={m.share_links_max_uses()}
              description={m.share_links_max_uses_hint()}
            >
              <Input
                id={ids.maxUses}
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                {...fieldAria(ids.maxUses, { description: true })}
              />
            </Field>
            <Field
              id={ids.maxViews}
              label={m.share_links_max_views()}
              description={m.share_links_max_views_hint()}
            >
              <Input
                id={ids.maxViews}
                type="number"
                min={1}
                value={maxViews}
                onChange={(e) => setMaxViews(e.target.value)}
                {...fieldAria(ids.maxViews, { description: true })}
              />
            </Field>
          </div>
          {hasDataRoom ? (
            <fieldset className="space-y-4 rounded-md border p-4">
              <legend className="px-1 text-sm font-medium">{m.share_links_target_legend()}</legend>
              <Field
                id={ids.target}
                label={m.share_links_target()}
                description={m.share_links_target_hint()}
              >
                <NativeSelect
                  id={ids.target}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  {...fieldAria(ids.target, { description: true })}
                >
                  <option value="">{m.share_links_target_none()}</option>
                  {targets.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="space-y-2">
                <p className="text-sm font-medium">{m.share_links_capabilities()}</p>
                {CAPABILITIES.map((cap) => {
                  const boxId = `share-link-cap-${cap}`;
                  return (
                    <div key={cap} className="flex items-center gap-2">
                      <Checkbox
                        id={boxId}
                        checked={capabilities.includes(cap)}
                        onCheckedChange={(on) =>
                          setCapabilities((cur) =>
                            on === true ? [...cur, cap] : cur.filter((c) => c !== cap),
                          )
                        }
                      />
                      <Label htmlFor={boxId}>{capabilityLabel(cap)}</Label>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
          {groups.data && groups.data.groups.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{m.share_links_groups()}</legend>
              <p className="text-sm text-muted-foreground">{m.share_links_groups_hint()}</p>
              {groups.data.groups.map((group) => {
                const boxId = `share-link-group-${group.id}`;
                return (
                  <div key={group.id} className="flex items-center gap-2">
                    <Checkbox
                      id={boxId}
                      checked={groupIds.includes(group.id)}
                      onCheckedChange={(on) =>
                        setGroupIds((cur) =>
                          on === true ? [...cur, group.id] : cur.filter((g) => g !== group.id),
                        )
                      }
                    />
                    <Label htmlFor={boxId}>{group.name}</Label>
                  </div>
                );
              })}
            </fieldset>
          ) : null}
          <div className="flex items-start gap-2">
            <Checkbox
              id={ids.watermark}
              checked={forceWatermark}
              onCheckedChange={(on) => setForceWatermark(on === true)}
            />
            <Label htmlFor={ids.watermark} className="leading-snug">
              {m.share_links_watermark()}
            </Label>
          </div>
          <Button type="submit" loading={create.isPending} disabled={label.trim() === ""}>
            {m.share_links_create_submit()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
