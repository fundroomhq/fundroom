import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ConfirmDialog, personName } from "../../../components/access/common.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { api, call, describeError, isApiError } from "../../../lib/api.js";
import { complianceSettingsQuery } from "../../../lib/compliance-queries.js";
import { peopleQuery } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

/*
 * DSAR erasure requests (E2.6, contract decision 5). Recording one starts the statutory clock
 * and asks every module that holds personal data to erase or pseudonymise it; each reports
 * back, and the request completes when the last expected module has. Both writes are `fresh`
 * routes, so `useGuardedMutation` sends a stale session through step-up and back here.
 *
 * The file is `-`-prefixed so the router generator does not treat it as a route.
 *
 * Since E2.7 the legal screen lists every kind of request in one place (`-data-requests.tsx`,
 * which also carries the cancel action); this file keeps the erasure creation card, reused
 * there unchanged.
 */

type ErasureRefusal = "legal_hold" | "erasure_open" | "last_owner";

/** The 409 reasons `POST /compliance/erasure-requests` can answer with. */
function conflictReason(error: unknown): ErasureRefusal | undefined {
  if (!isApiError(error) || error.status !== 409) return undefined;
  const reason = error.body.error["reason"];
  return reason === "legal_hold" || reason === "erasure_open" || reason === "last_owner"
    ? reason
    : undefined;
}

export function CreateErasureCard() {
  const [q, setQ] = useState("");
  const [membershipId, setMembershipId] = useState("");
  const [note, setNote] = useState("");
  const [refusal, setRefusal] = useState<ErasureRefusal | undefined>(undefined);
  const base = useId();
  const settings = useQuery(complianceSettingsQuery);
  // The directory is another area's route (`access.read`): without it the picker is empty and
  // says so, rather than taking the whole tab down.
  const people = useQuery({ ...peopleQuery({ q: q.trim() || undefined }), retry: false });
  const queryClient = useQueryClient();
  const create = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/compliance/erasure-requests", {
          body: { membershipId, ...(note.trim() === "" ? {} : { note: note.trim() }) },
        }),
      ),
    onSuccess: () => {
      toast.success(m.erasure_created());
      setMembershipId("");
      setNote("");
      setRefusal(undefined);
      void queryClient.invalidateQueries({ queryKey: ["compliance", "erasure-requests"] });
      void queryClient.invalidateQueries({ queryKey: ["compliance", "data-requests"] });
    },
    onError: (error) => {
      const reason = conflictReason(error);
      if (reason !== undefined) {
        setRefusal(reason);
        return;
      }
      toast.error(describeError(error).title);
    },
  });
  const candidates = people.data?.items ?? [];
  const picked = candidates.find((p) => p.membershipId === membershipId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.erasure_create_title()}</CardTitle>
        <CardDescription>{m.erasure_create_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings.data?.legalHold ? (
          <Alert variant="warning">
            <AlertTitle>{m.erasure_hold_title()}</AlertTitle>
            <AlertDescription>{m.erasure_hold_body()}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field id={`${base}-q`} label={m.erasure_field_search()}>
            <Input
              id={`${base}-q`}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </Field>
          <Field
            id={`${base}-member`}
            label={m.erasure_field_member()}
            description={people.isError ? m.erasure_people_unavailable() : undefined}
          >
            <NativeSelect
              id={`${base}-member`}
              value={membershipId}
              {...(people.isError ? { "aria-describedby": `${base}-member-description` } : {})}
              onChange={(e) => {
                setMembershipId(e.target.value);
                setRefusal(undefined);
              }}
            >
              <option value="">{m.erasure_member_pick()}</option>
              {candidates.map((p) => (
                <option key={p.membershipId} value={p.membershipId}>
                  {p.email ? `${personName(p)} (${p.email})` : personName(p)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id={`${base}-note`}
            label={m.erasure_field_note()}
            description={m.erasure_field_note_hint()}
            className="md:col-span-2"
          >
            <Textarea
              id={`${base}-note`}
              value={note}
              maxLength={1000}
              aria-describedby={`${base}-note-description`}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>
        {refusal === "legal_hold" ? (
          <Alert variant="destructive">
            <AlertTitle>{m.erasure_refused_hold_title()}</AlertTitle>
            <AlertDescription>{m.erasure_refused_hold_body()}</AlertDescription>
          </Alert>
        ) : null}
        {refusal === "last_owner" ? (
          <Alert variant="destructive">
            <AlertTitle>{m.erasure_refused_last_owner_title()}</AlertTitle>
            <AlertDescription>{m.erasure_refused_last_owner_body()}</AlertDescription>
          </Alert>
        ) : null}
        {refusal === "erasure_open" ? (
          <Alert variant="destructive">
            <AlertTitle>{m.erasure_refused_open_title()}</AlertTitle>
            <AlertDescription>{m.erasure_refused_open_body()}</AlertDescription>
          </Alert>
        ) : null}
        <ConfirmDialog
          trigger={
            <Button type="button" variant="destructive" disabled={membershipId === ""}>
              {m.erasure_create_submit()}
            </Button>
          }
          title={m.erasure_confirm_title({
            name: picked ? personName(picked) : membershipId.slice(0, 8),
          })}
          description={m.erasure_confirm_body()}
          confirmLabel={m.erasure_create_submit()}
          pending={create.isPending}
          onConfirm={() => create.mutate()}
        />
      </CardContent>
    </Card>
  );
}
