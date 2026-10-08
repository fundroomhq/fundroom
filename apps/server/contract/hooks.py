"""Schemathesis hooks for the CI contract job (`schemathesis.toml` beside this file loads it).

The accreditation evidence upload (`PUT /round/verifications/{id}/evidence`) takes raw bytes as
`application/pdf`, `image/png` or `image/jpeg`. Schemathesis ships a serializer for
`application/octet-stream` only; these media types are bytes on the wire in exactly the same way,
so they reuse it rather than leaving the operation untestable.
"""

import schemathesis

schemathesis.serializer.alias(
    ["application/pdf", "image/png", "image/jpeg"], "application/octet-stream"
)
