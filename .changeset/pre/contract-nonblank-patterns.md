---
"@fundroom/server": patch
---

The OpenAPI document now states that trimmed text fields must contain a non-blank character. Request strings the server trims before checking their length carry a `pattern` matching exactly what is left after trimming, so a value of only whitespace is no longer schema-valid. The server already refused such values; only the published contract changes.
