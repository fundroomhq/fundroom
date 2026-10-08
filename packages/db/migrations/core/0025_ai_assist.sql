-- 0025_ai_assist — AI assist requests and monthly usage (EXECUTION_PLAN §15 E3.12, ADR-0060).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/ai.ts; the kernel that owns both
-- tables is @seed-host/ai (start, the `ai.run` job, the retention sweep, erasure deletion). Runs
-- inside one transaction; each table declares its fence inline so nothing can read a row between
-- CREATE TABLE and the runner's core.apply_tenant_fence() pass.
--
--  * ai_request        one AI suggestion: queued → running → done | failed | refused, or cancelled.
--                      `result` is a SUGGESTION a staff member reads and applies through the
--                      product's normal write paths — AI never writes tenant content. Rows are
--                      transient (deleted after AI_RESULT_RETENTION_HOURS, by `expires_at`) and are
--                      not exported. No prompt or model output text is stored except `result`.
--  * ai_usage_monthly  tokens and requests per workspace per UTC calendar month (the budget).
--                      Instance-local: not exported.
--
-- RLS: the fence plus a permissive staff/system policy. External members read nothing here.

--> statement-breakpoint
CREATE TABLE core.ai_request (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  feature text NOT NULL,
  -- the question id for qa_answer; NULL for update_draft
  subject_id uuid,
  requested_by uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  params_schema_version integer NOT NULL DEFAULT 1,
  result jsonb,
  result_schema_version integer,
  error_code text,
  -- the provider identity and model the request was started against (never a key)
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT ai_request_feature CHECK (feature IN ('update_draft', 'qa_answer')),
  CONSTRAINT ai_request_status CHECK (
    status IN ('queued', 'running', 'done', 'failed', 'refused', 'cancelled')
  ),
  CONSTRAINT ai_request_error_code CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,64}$'),
  CONSTRAINT ai_request_params_object CHECK (jsonb_typeof(params) = 'object'),
  CONSTRAINT ai_request_result_object CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  CONSTRAINT ai_request_result_version CHECK (
    (result IS NULL) = (result_schema_version IS NULL)
  ),
  CONSTRAINT ai_request_provider_length CHECK (char_length(provider) BETWEEN 1 AND 400),
  CONSTRAINT ai_request_model_length CHECK (char_length(model) BETWEEN 1 AND 200),
  CONSTRAINT ai_request_tokens_non_negative CHECK (input_tokens >= 0 AND output_tokens >= 0)
);

CREATE INDEX ai_request_inflight_idx ON core.ai_request (workspace_id, status)
  WHERE status IN ('queued', 'running');
CREATE INDEX ai_request_subject_inflight_idx ON core.ai_request (workspace_id, feature, subject_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX ai_request_requested_by_idx ON core.ai_request (requested_by);
CREATE INDEX ai_request_expires_idx ON core.ai_request (expires_at);

CREATE TRIGGER ai_request_set_updated_at BEFORE UPDATE ON core.ai_request
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.ai_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ai_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.ai_request AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY ai_request_staff ON core.ai_request FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
CREATE TABLE core.ai_usage_monthly (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- the first day of the UTC calendar month
  month date NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, month),
  CONSTRAINT ai_usage_monthly_month_start CHECK (date_trunc('month', month) = month),
  CONSTRAINT ai_usage_monthly_non_negative CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND requests >= 0
  )
);

ALTER TABLE core.ai_usage_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ai_usage_monthly FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.ai_usage_monthly AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY ai_usage_monthly_staff ON core.ai_usage_monthly FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
