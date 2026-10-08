import { Badge, Checkbox, Label, LoadingState } from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import {
  disabledReasonLabel,
  groupTopics,
  WEBHOOK_VERIFY_DOCS_URL,
  type WebhookEndpoint,
  webhookTopicsQuery,
} from "../../lib/webhooks-queries.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";
import { ShownOnce } from "../shown-once.js";

/** Enabled, or why not: "the receiver said 410" and "an admin switched it off" differ. */
export function EndpointStatusBadge({ endpoint }: { endpoint: WebhookEndpoint }) {
  if (endpoint.enabled) return <Badge variant="success">{m.webhooks_enabled()}</Badge>;
  return (
    <Badge variant={endpoint.disabledReason === "manual" ? "outline" : "destructive"}>
      {endpoint.disabledReason === null
        ? m.webhooks_disabled()
        : disabledReasonLabel(endpoint.disabledReason)}
    </Badge>
  );
}

/**
 * Topic checkboxes grouped by the module that offers them (only enabled modules' topics come
 * back). Person-level engagement topics carry the consent caveat beside them: a subscriber who
 * expects every "document viewed" will otherwise read the gaps as a bug.
 *
 * A subscribed topic the server no longer offers (its module was switched off) is still listed,
 * so saving the form does not silently drop it.
 */
export function TopicPicker({
  value,
  onChange,
  addable,
}: {
  value: readonly string[];
  onChange: (next: readonly string[]) => void;
  /**
   * A-3: on a plan without `webhooks` an endpoint can drop topics but not take on new ones —
   * only these (its saved topics) can be ticked. `undefined`: any.
   */
  addable?: readonly string[] | undefined;
}) {
  const topics = useQuery(webhookTopicsQuery);
  const baseId = useId();
  const offered = new Set((topics.data?.topics ?? []).map((t) => t.topic));
  const orphans = value.filter((t) => !offered.has(t));
  const toggle = (topic: string, on: boolean) =>
    onChange(on ? [...value, topic] : value.filter((t) => t !== topic));
  return (
    <fieldset className="space-y-3" aria-describedby={`${baseId}-hint`}>
      <legend className="text-sm font-medium">{m.webhooks_field_events()}</legend>
      <p id={`${baseId}-hint`} className="text-sm text-muted-foreground">
        {m.webhooks_field_events_hint()}
      </p>
      {topics.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
      {topics.isError ? <ErrorAlert error={topics.error} /> : null}
      {topics.data
        ? groupTopics(topics.data.topics).map(({ moduleId, topics: list }) => (
            <fieldset key={moduleId} className="space-y-2 rounded-md border p-3">
              <legend className="px-1 font-mono text-xs">{moduleId}</legend>
              {list.map((topic) => {
                const boxId = `${baseId}-${topic.topic}`;
                return (
                  <div key={topic.topic} className="flex items-start gap-2">
                    <Checkbox
                      id={boxId}
                      className="mt-0.5"
                      checked={value.includes(topic.topic)}
                      disabled={addable !== undefined && !addable.includes(topic.topic)}
                      aria-describedby={`${boxId}-desc`}
                      onCheckedChange={(on) => toggle(topic.topic, on === true)}
                    />
                    <div className="grid gap-0.5">
                      <Label htmlFor={boxId} className="font-mono text-xs">
                        {topic.topic}
                      </Label>
                      <p id={`${boxId}-desc`} className="text-xs text-muted-foreground">
                        {topic.description}
                        {topic.personLevel ? (
                          <>
                            {" "}
                            <span className="font-medium">{m.webhooks_person_level_hint()}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </div>
                );
              })}
            </fieldset>
          ))
        : null}
      {topics.data && orphans.length > 0 ? (
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-xs">{m.webhooks_topics_unavailable()}</legend>
          {orphans.map((topic) => {
            const boxId = `${baseId}-orphan-${topic}`;
            return (
              <div key={topic} className="flex items-center gap-2">
                <Checkbox id={boxId} checked onCheckedChange={(on) => toggle(topic, on === true)} />
                <Label htmlFor={boxId} className="font-mono text-xs">
                  {topic}
                </Label>
              </div>
            );
          })}
        </fieldset>
      ) : null}
    </fieldset>
  );
}

/** The signing secret, once, with where to read how a receiver checks a signature. */
export function SecretShownOnce({
  title,
  secret,
  onDismiss,
}: {
  title: string;
  secret: string;
  onDismiss: () => void;
}) {
  return (
    <ShownOnce
      title={title}
      value={secret}
      copyLabel={m.webhooks_copy_secret()}
      onDismiss={onDismiss}
    >
      <p>
        {m.webhooks_verify_hint()}{" "}
        <a
          href={WEBHOOK_VERIFY_DOCS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium underline underline-offset-4"
        >
          {m.webhooks_verify_link()}
        </a>
      </p>
    </ShownOnce>
  );
}
