-- 0027_fundroom_identifiers — the FundRoom identifier rename (A-2 / E-UP-1b, ADR-0062).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/api.ts. Runs inside one transaction.
--
--  * api_key.prefix   new workspace API keys are minted `frk_…` (packages/api-keys/src/token.ts).
--                     Keys minted before the rename keep their `shk_…` prefix and keep working —
--                     the lookup hashes the whole token and never reads this column — so the
--                     display-prefix CHECK accepts both spellings. Without this, minting an
--                     `frk_` key fails the insert. Rotation replaces an old key with an `frk_` one.
--
-- SCIM tokens (`shs_` → `frs_`) need nothing here: core.scim_token has no prefix CHECK.

--> statement-breakpoint
ALTER TABLE core.api_key DROP CONSTRAINT api_key_prefix_shape;
ALTER TABLE core.api_key ADD CONSTRAINT api_key_prefix_shape
  CHECK (prefix ~ '^(shk|frk)_[A-Za-z0-9_-]{8}$');
