# @fundroom/domain

Pure definitions with no I/O. Today: the domain event
catalogue (`EVENT_CATALOGUE`), the contract between bounded contexts.

```ts
import { defineEvent, parseEventPayload, EVENT_TOPICS } from "@fundroom/domain";
const e = defineEvent("document.viewed", { documentId, versionId, membershipId, sessionId: null });
```

Payloads are strict Zod objects carrying ids only (never emails, names or document titles),
each with a `schemaVersion`; the outbox row stores the version it was written with, and
`parseEventPayload` refuses versions it cannot read (add an upcaster there rather than
editing stored rows). Adding a topic is an API change: add a changeset.
