# @fundroom/accred-manual

`AccreditationVerificationPort` for `ACCREDITATION_DRIVER=manual`: the
investor uploads evidence, a staff member reads it and records the decision on the
`round.verification` row. `start()` and `check()` both answer `pending`, because nothing this
adapter can see settles a Rule 506(c) verification — `requires.adminDecision` says so, and the
round module's queue is what acts on it.

```ts
import { createManualAccreditationProvider } from "@fundroom/accred-manual";

const provider = createManualAccreditationProvider({ log });
provider.requires; // { evidenceUpload: true, adminDecision: true }
```
