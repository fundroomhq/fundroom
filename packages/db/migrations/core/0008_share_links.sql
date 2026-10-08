-- 0008_share_links — the share link an admin mints, the visitors it admits, and the `link`
-- policy target (EXECUTION_PLAN §7 and §11, E2.3 at :909; design/04 §8 R11/R6/R1, design/05 §5;
-- ADR-0004, ADR-0014, ADR-0032, ADR-0041).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/share-links.ts. Runs inside one
-- transaction. All three fences are declared inline so nothing can read a row between CREATE
-- TABLE and the runner's core.apply_tenant_fence() pass, and because the helper installs only
-- the *restrictive* half; the permissive half is where these three tables differ from each
-- other and from everything else in core, so it has to be written out.
--
-- Model (design/05 §5 "Visiting = email OTP → policy gates → membership created with
-- source=link:<id>"; EXECUTION_PLAN §7 names `core` as the owner of share links):
--
--  * share_link        one row per link an admin mints, holding the token digest, the admission
--                      controls (domain/named-email policy, passcode, expiry, use and view
--                      ceilings) and the grants a redeemer receives. Kernel, not a module table:
--                      the link *is* a grant subject — core.access_grant.subject_kind already
--                      contains 'link' (0004_access.sql:22), reserved for this epic — so a link
--                      that lived in a module table would be an authorization fact a disabled
--                      module could take away. It is also read by the tenant-side resolver before
--                      any module is consulted.
--
--  * share_link_visit  the membership ↔ link binding: which memberships a link admitted, and
--                      whether that binding is still live. Kernel for a sharper reason — it is
--                      an *authorization edge*. `PrincipalRepo` walks it to emit the `link`
--                      subject for a membership, so a row here is what makes the link's grants
--                      materialise into core.effective_access for that person (ADR-0032 §2).
--                      Writing one is equivalent to granting access, which is why nothing below
--                      lets an external member write it.
--
--  * share_link_view   one row per (link, membership, session) that has already been counted
--                      against the link's view budget. Kernel because the budget is an access
--                      control, not analytics: design/05 §4.4 says a view limit "counts unique
--                      sessions, not requests", and with nothing to conflict against, "unique"
--                      degrades to "unique to this process since it last started" — a redeploy
--                      or a second node hands every live session another view. The row is the
--                      memory: `INSERT … ON CONFLICT DO NOTHING RETURNING` both asks "was this
--                      session counted?" and records the answer in one statement, so there is
--                      no window between the question and the write, and the answer outlives
--                      the process that wrote it.
--
-- The grant subject stays the *link*, never a per-visitor copy: revoking the link stops the
-- subject being emitted for every membership it ever admitted, so one write revokes everyone
-- (design/03 B3, and E2.3 decision D8).
--
-- The plaintext token is never stored — only sha256 of it, like core.auth_challenge.secret_hash
-- (0001_identity.sql:129). The passcode digest is a *keyed* HMAC rather than a bare sha256:
-- passcodes are chosen by humans and have perhaps 20 bits of entropy, so an unkeyed digest of a
-- stolen dump is a dictionary attack with no work factor. The key lives outside the database.
--
-- ALTER TYPE core.policy_target_kind ADD VALUE 'link' is the last statement here and the new
-- value is deliberately *not used* anywhere in this file: Postgres permits ADD VALUE inside a
-- transaction block but refuses to let the same transaction resolve the literal ("unsafe use of
-- new value of enum type"), which is what recreating access_policy_target_shape would do. That
-- lives in 0009_link_policy_target.sql, one transaction later.

CREATE TYPE core.share_link_status AS ENUM ('active', 'paused', 'revoked');

--> statement-breakpoint
CREATE TABLE core.share_link (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- what the admin calls it; shown in the links list and in every audit row
  label text NOT NULL,
  -- sha256(randomToken()); the plaintext is returned by mint() once and never stored
  token_hash bytea NOT NULL,
  status core.share_link_status NOT NULL DEFAULT 'active',
  -- LinkPolicy: domain allowlist, named emails, forced watermark (@seed-host/share-links)
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_schema_version integer NOT NULL DEFAULT 1,
  -- the grants a redeemer receives, reusing the invite's InviteGrantsSchema
  grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  grants_schema_version integer NOT NULL DEFAULT 1,
  -- target group(s), applied on membership creation exactly as an invite's are
  group_ids uuid[] NOT NULL DEFAULT '{}',
  -- keyed HMAC-SHA256, never a bare digest: a passcode carries too little entropy for one
  passcode_hash bytea,
  -- the guess counter lives on the row being guessed, not on a client IP: behind the shipped
  -- Caddy the first X-Forwarded-For hop is attacker-supplied (ADR-0039 decision 4), so an IP
  -- bucket gives an attacker a fresh allowance per spoofed value. core.auth_challenge.attempts
  -- already counts OTP guesses this way (E2.3 decision D7).
  passcode_attempts integer NOT NULL DEFAULT 0,
  passcode_locked_until timestamptz,
  -- distinct memberships admitted (design/05 §5 "max uses")
  max_uses integer,
  uses integer NOT NULL DEFAULT 0,
  -- distinct view sessions (design/05:175 "view limit")
  max_views integer,
  views integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  -- membership id of the staff member who minted it; nullable like the other core tables
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT share_link_label_length CHECK (char_length(label) BETWEEN 1 AND 200),
  -- A backstop against a direct SQL write, not the product rule: the digest is produced by
  -- sha256() in @seed-host/identity, and a short value here would mean somebody stored a prefix.
  CONSTRAINT share_link_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT share_link_passcode_hash_length CHECK (
    passcode_hash IS NULL OR octet_length(passcode_hash) = 32
  ),
  CONSTRAINT share_link_max_uses_positive CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT share_link_max_views_positive CHECK (max_views IS NULL OR max_views > 0),
  CONSTRAINT share_link_counters_nonnegative CHECK (
    uses >= 0 AND views >= 0 AND passcode_attempts >= 0
  )
);

-- THE lookup, and the uniqueness that makes a token mean one link.
--
-- Not workspace-leading and not partial, on purpose: resolve() is handed a digest and nothing
-- else, and a revoked or expired link must still be *found* so the route can answer the same
-- 404 an unknown token gets (E2.3 decision D7) after the same amount of work. A partial index
-- over live rows would turn "revoked" into a measurably faster miss, which is the enumeration
-- oracle the 404 exists to close. Global rather than per-workspace because a 256-bit token is
-- already globally unique and a collision across workspaces would be a cross-tenant resolve.
CREATE UNIQUE INDEX share_link_token_hash_idx ON core.share_link (token_hash);

-- The admin list: newest first, live rows only.
CREATE INDEX share_link_ws_idx ON core.share_link (workspace_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- §13.2's revocation cascade ("pending invites and links they created are cancelled") reads
-- exactly this: every live link one departing staff member minted.
CREATE INDEX share_link_creator_idx ON core.share_link (workspace_id, created_by)
  WHERE revoked_at IS NULL;

CREATE TRIGGER share_link_set_updated_at BEFORE UPDATE ON core.share_link
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

--> statement-breakpoint
CREATE TABLE core.share_link_visit (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES core.share_link (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  views integer NOT NULL DEFAULT 0,
  passcode_ok_at timestamptz,
  -- unbinding one visitor without revoking the link for everybody else
  revoked_at timestamptz,
  CONSTRAINT share_link_visit_views_nonnegative CHECK (views >= 0)
);

-- One binding per (link, membership). A visitor may redeem several links and a link admits
-- many visitors, so the pair is the identity and `uses` counts *distinct memberships*: a
-- returning visitor re-resolving their own link must not burn another use.
CREATE UNIQUE INDEX share_link_visit_pair_idx ON core.share_link_visit (link_id, membership_id);

-- The join PrincipalRepo walks on every rebuild to emit `link` subjects: membership-leading,
-- because the rebuild asks "which links is this person bound to", never the other way round,
-- and live rows only, because a revoked binding must contribute no subject.
CREATE INDEX share_link_visit_membership_idx
  ON core.share_link_visit (workspace_id, membership_id) WHERE revoked_at IS NULL;

--> statement-breakpoint
CREATE TABLE core.share_link_view (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES core.share_link (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  -- core.session.id, as a bare uuid, exactly as audit.event.session_id holds it
  -- (0002_audit_events.sql:41).
  --
  -- Not a digest. A session id is credential-*adjacent*, not a credential: core.session keeps
  -- the bearer secret in its own column, token_hash (0001_identity.sql:89), and hands out
  -- `id` as the surrogate everything else quotes it by. Whoever holds this uuid can do nothing
  -- with it: the session cannot be resumed from its id, and core.session's own fence already
  -- limits a reader to the host context or their own rows, so the worst a visitor could learn
  -- from one is the id of a session they were holding anyway. Hashing it would protect nothing
  -- while destroying the one thing the column is good for besides deduping: joining a counted
  -- view to audit.event on session_id, which is how "what else did the session that burned
  -- this view do" gets answered. Two representations of the same fact, one hashed and one not,
  -- would also be a standing invitation to compare them wrongly.
  --
  -- No foreign key to core.session, and that is deliberate rather than an omission. Sessions
  -- are *deleted* once expired or long revoked (deleteDeadSessions, the E0.4 cleanup job), so
  -- ON DELETE CASCADE would quietly refund a view budget every time the job ran — the exact
  -- failure this table exists to close, arriving on a timer instead of on a redeploy — and
  -- NO ACTION would make the cleanup job fail on any session that ever viewed a link. audit
  -- leaves session_id unreferenced for the same reason: the record of what happened must
  -- outlive the session it happened in.
  session_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  -- The primary key *is* the dedup. `INSERT … ON CONFLICT DO NOTHING RETURNING` asks and
  -- answers in one statement: a returned row means this session had not been counted and now
  -- is, no row means it had. There is no read-then-write window for two concurrent requests of
  -- the same session to both win, and the answer is in the database, so a restart or a second
  -- node reaches it too.
  --
  -- Leading with link_id also gives the share_link cascade an index to probe, which is the
  -- delete that actually happens: dropping a link drops its counted views. workspace_id is
  -- outside the key on purpose — it is denormalised for the tenant fence
  -- (core.check_tenant_fence() requires the column), not for identity, which link_id alone
  -- already pins to one workspace.
  PRIMARY KEY (link_id, membership_id, session_id)
);

-- No second index, and no `id` surrogate. The only query this table serves is the claim above,
-- and the primary key is that query: three equalities, one probe, one row. The admin screen
-- counts *bindings* (core.share_link_visit), never sessions, so nothing lists these rows.
--
-- The membership and workspace cascades are left unindexed, exactly as core.share_link_visit
-- beside it leaves its own (its only full index is (link_id, membership_id)). An index per
-- cascading foreign key would tax every view claim — the hot write on this table — to speed up
-- a delete each row sees at most once, when its workspace or its member is erased, and those
-- run as one-off administrative statements that can afford the scan.

--> statement-breakpoint
-- Row-level security.
--
-- core.share_link is resolved by token *before any membership exists*: the visitor arriving at
-- /s/<token> has no membership, so the resolver runs as the `system` actor inside the workspace
-- the hostname or slug already resolved to. The fence is therefore the plain workspace shape —
-- unlike core.custom_domain, there is no pre-tenant read here and admitting the `host` actor
-- would widen the surface for nothing.
--
-- The permissive policy admits `staff` (the admin screen) and `system` (resolve, the passcode
-- counter, redeem, noteView) and *nobody else*. An `external` member therefore matches no
-- permissive policy on this table and sees zero rows, which is how "an external member must
-- never read token_hash or passcode_hash" is enforced: not by hiding two columns, but by there
-- being no row for them to project. That matters because both columns are guessing targets —
-- token_hash is the link itself and passcode_hash is a low-entropy digest — and a link visitor
-- *is* an external member the moment they are admitted, so "already inside" must not mean
-- "can read the credential that let them in", nor anybody else's.
--
-- Postgres RLS is row-level only, so there is no policy that could return the row while
-- withholding those two columns. If a later epic needs a visitor to see their own link's label,
-- it must come from the system actor through a projection, or from a view — never by adding a
-- permissive external policy here, which would carry the digests with it.
ALTER TABLE core.share_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.share_link FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.share_link AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY share_link_staff ON core.share_link FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

-- core.share_link_visit is an authorization edge, so the write side is the security boundary:
-- a row here makes the link's grants materialise for that membership on the next rebuild. An
-- external member who could INSERT one would grant themselves every capability the link
-- carries, without ever holding the token, the passcode or the OTP — the three secrets D7 is
-- built around. So writes are `staff` and `system` only; redeem() runs as `system`.
--
-- Reads are narrower than the workspace: an external member sees *its own* bindings and no
-- others. Another visitor's row names their membership, when they arrived and how much they
-- have looked at — an attendance list for whoever else was sent the same link — and the link
-- is often the only thing two visitors have in common. `core.attestation` and
-- `core.consent_event` already draw this line the same way (0006_compliance.sql:225-239).
ALTER TABLE core.share_link_visit ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.share_link_visit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.share_link_visit AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY share_link_visit_staff ON core.share_link_visit FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY share_link_visit_external_own ON core.share_link_visit FOR SELECT
  USING (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());

-- core.share_link_view follows core.share_link, not core.share_link_visit: `staff` and `system`,
-- and an external member matches no permissive policy at all. noteView() runs as `system`
-- (there is nothing here an unprivileged context needs to write), so the only question worth
-- arguing is whether an external member should read *its own* rows, the way it reads its own
-- binding one table up. It should not, for three reasons:
--
--  1. The visit row is a fact about the visitor — an admission they took part in, whose effects
--     they can already see. A view row is a fact about a *control being applied to them*. It is
--     the meter on max_views, which is a ceiling the sharer set and the visitor is subject to.
--  2. Reading it teaches the metering rule. Rows appearing one per session and never per
--     request says, precisely: a reload is free, a fresh login costs a view. That is the recipe
--     both for stretching your own budget and — sharper — for burning a link's budget to deny
--     everyone else on it, which is a real move when the same link was sent to several rival
--     investors. A quota is easier to hold when the party being metered does not hold the
--     ledger.
--  3. Nothing needs it. No visitor-facing surface in this epic shows view counts, and if one
--     ever should ("3 of 10 views used"), A4's rule applies unchanged: project it server-side
--     from the system read. A permissive policy added now for a screen that does not exist is
--     a permission nobody will remember to remove.
--
-- `staff` gets FOR ALL rather than FOR SELECT, matching both tables above. A staff member who
-- deleted rows here would refund their own link's view budget — but they can already raise
-- max_views on a link they own with one UPDATE, so the write adds no capability; splitting the
-- policy would only make this table the odd one out.
ALTER TABLE core.share_link_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.share_link_view FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.share_link_view AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY share_link_view_staff ON core.share_link_view FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

--> statement-breakpoint
-- The `link` policy target (E2.3 decision D3): an NDA or accreditation gate attached to a share
-- link rather than to a group, a membership or a resource. core.policy_kind is unchanged — nda,
-- accredited, min_auth_level and ip_allowlist already cover every gate this epic needs.
--
-- This must be the last statement in the file and nothing above may reference 'link'. Postgres
-- allows ADD VALUE inside a transaction block, but the added value cannot be resolved until the
-- transaction commits; 0009_link_policy_target.sql recreates the access_policy_target_shape
-- CHECK with the `link` arm from the next transaction.
ALTER TYPE core.policy_target_kind ADD VALUE 'link';

SELECT core.apply_tenant_fence();
