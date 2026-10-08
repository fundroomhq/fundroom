-- 0010_mail_feedback — the sent-message index that routes ESP delivery feedback back to a
-- workspace, and the per-workspace suppression list that feedback builds (E2.6, design/04 §3.2,
-- design/03 C2; ADR-0004).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/mail.ts. Runs inside one transaction.
-- Both fences are declared inline so nothing can read a row before the runner's
-- core.apply_tenant_fence() pass, and because mail_message's fence is not the plain shape.
--
-- Model:
--
--  * mail_message      one row per message the composition root handed to the provider on behalf
--                      of a workspace, written after the provider accepted it. It is the only
--                      thing that turns an ESP webhook — which carries a provider message id and
--                      nothing else we trust — into (workspace, stream, resource, member). Ids
--                      only: no address, no subject, no body. Kernel, not a module table: the
--                      lookup runs before any workspace is known (the `/internal/tls/ask`
--                      precedent in 0007), and the suppression it feeds must hold for every
--                      module that sends mail.
--
--  * mail_suppression  the addresses a workspace must not send broadcast or notification mail to
--                      after a hard bounce or a spam complaint (or an admin's manual entry).
--                      Keyed by an HMAC of the lower-cased address under the workspace's own
--                      `mail-suppression` data key, never the address: the list exists to stop
--                      mail, and it needs no address to do that. `address_masked` (`j•••@acme.com`)
--                      is what the admin screen shows. Transactional mail (sign-in codes) is never
--                      checked against it — a person whose address once bounced must still be able
--                      to sign in. `key_id` names the data key the hash was taken under:
--                      `crypto.rotate` is routine, and a lookup hashes the address under every
--                      key the workspace holds for the purpose (retired ones included), so an
--                      entry written before a rotation keeps matching after it. The addresses
--                      themselves are never stored, so re-hashing under the new key is impossible.

CREATE TABLE core.mail_message (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- MailerPort.driver at send time (`resend`, `postmark`, `ses`, `smtp`, …)
  provider text NOT NULL,
  -- SentEmail.messageId as the provider reported it; what its webhooks quote back
  provider_message_id text NOT NULL,
  stream text NOT NULL,
  -- OutboundEmail.ref: what the message is about. Ids only.
  ref_kind text,
  ref_id uuid,
  membership_id uuid,
  -- what the sender asked for; the webhook re-checks consent regardless (decision 1)
  tracking_opens boolean NOT NULL DEFAULT false,
  tracking_clicks boolean NOT NULL DEFAULT false,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_message_stream CHECK (stream IN ('transactional', 'broadcast', 'notification')),
  CONSTRAINT mail_message_provider_length CHECK (char_length(provider) BETWEEN 1 AND 64),
  CONSTRAINT mail_message_provider_id_length CHECK (
    char_length(provider_message_id) BETWEEN 1 AND 300
  ),
  CONSTRAINT mail_message_ref_kind_length CHECK (
    ref_kind IS NULL OR char_length(ref_kind) BETWEEN 1 AND 64
  )
);

-- THE webhook lookup. Global, not workspace-leading: the webhook knows the provider id and
-- nothing else. Unique because a provider id names one message; a second insert for the same id
-- (a retried send the provider deduplicated) is a no-op, never a second workspace claiming it.
CREATE UNIQUE INDEX mail_message_provider_idx ON core.mail_message (provider, provider_message_id);

-- Per-workspace age scans (retention, "what did we send this member").
CREATE INDEX mail_message_ws_sent_idx ON core.mail_message (workspace_id, sent_at);

--> statement-breakpoint
CREATE TABLE core.mail_suppression (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- HMAC-SHA256(workspace `mail-suppression` key, lower(trim(address)))
  address_hash bytea NOT NULL,
  -- the core.workspace_key the hash was taken under (keys are retired, never deleted)
  key_id uuid NOT NULL REFERENCES core.workspace_key (id),
  -- a stable id for the admin API and the audit row's resource_id (audit.event.resource_id is uuid)
  id uuid NOT NULL DEFAULT core.uuidv7(),
  -- `j•••@acme.com`: enough for an admin to recognise, not enough to mail
  address_masked text NOT NULL,
  reason text NOT NULL,
  -- the core.mail_message the bounce or complaint was about; null for a manual entry
  message_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- membership id of the admin for a manual entry; null when the ESP put it there
  created_by uuid,
  PRIMARY KEY (workspace_id, address_hash),
  -- `provider`: the ESP's own suppression list refused the recipient (E2.6 FX1)
  CONSTRAINT mail_suppression_reason CHECK (reason IN ('bounce', 'complaint', 'manual', 'provider')),
  CONSTRAINT mail_suppression_hash_length CHECK (octet_length(address_hash) = 32),
  CONSTRAINT mail_suppression_masked_length CHECK (char_length(address_masked) BETWEEN 1 AND 320)
);

CREATE UNIQUE INDEX mail_suppression_id_idx ON core.mail_suppression (id);

-- The admin list: newest first, keyset on the time-ordered uuidv7 id alone (a created_at cursor
-- would lose rows to the microsecond/millisecond mismatch between Postgres and a JS Date).
CREATE INDEX mail_suppression_ws_id_idx ON core.mail_suppression (workspace_id, id DESC);

--> statement-breakpoint
-- Row-level security.
--
-- mail_message is read *before* a workspace is known: the ESP webhook carries a provider message
-- id and the ingress must find the workspace from it. So, like core.custom_domain (0007) and the
-- `/internal/tls/ask` lookup behind it, the fence admits the host actor — but more narrowly: the
-- host may only SELECT. The restrictive fence's WITH CHECK names the workspace alone, and the only
-- permissive policy the host has is FOR SELECT, so a host-context transaction can neither write,
-- update nor delete a row. Every write happens in the owning workspace's system context (the send
-- wrapper), and everything after the lookup — suppression, consent, the event — runs there too.
-- External members see nothing: which messages were sent to whom is staff business.
ALTER TABLE core.mail_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.mail_message FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.mail_message AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY mail_message_staff ON core.mail_message FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY mail_message_host_read ON core.mail_message FOR SELECT
  USING (core.current_actor_kind() = 'host');

-- mail_suppression is the plain shape: one workspace, staff and system only. The webhook reaches
-- it after the lookup above has named the workspace, in that workspace's system context.
ALTER TABLE core.mail_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.mail_suppression FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.mail_suppression AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY mail_suppression_staff ON core.mail_suppression FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
