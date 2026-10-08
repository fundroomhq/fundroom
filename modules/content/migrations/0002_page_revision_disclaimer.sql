-- 0002_page_revision_disclaimer — stamp the legal disclaimer version onto a published page
-- revision (E1.6, design/04 "provable history", ADR-0033).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/content.ts. Runs inside one
-- transaction. The column is a *string* (`<slug>:v<n>`), not a foreign key: the revision is
-- an immutable snapshot and must stay readable years later, after the legal document itself
-- has been renamed or deleted. NULL means the workspace had no disclaimer when it published.
--
-- Adding a column to a table this module already owns needs no new grants or policy: the
-- tenant fence and the `seedhost_app` privileges on content.page_revision cover it.

ALTER TABLE content.page_revision ADD COLUMN disclaimer_version text;
