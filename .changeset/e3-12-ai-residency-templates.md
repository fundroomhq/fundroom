---
"@fundroom/compliance": minor
"@fundroom/contracts": minor
---

AI assist residency facts: a new `ai` residency component (present only when an AI model
provider is configured; self-hosted counts as the operator's own cell, a third party is compared by
jurisdiction), a third-party provider as a deployment sub-processor and — while a workspace has AI
assist effectively on — as that workspace's own vendor, and a new `{{aiAssist}}` merge field.

Template versions: `privacy-notice` 2 → 3 (new "AI assist" section; "Automated decisions" says AI
assist only drafts for staff review) and `dpa` 2 → 3 (nature and purpose of processing now covers
sending content extracts to the configured AI model where the customer turns AI assist on). Both
require acceptance: tenants whose documents are based on version 2 see that the library moved ahead.
