---
"@fundroom/server": patch
---

The outbox relay no longer skips a row the database stamped within the relay clock's current millisecond. `available_at` has microsecond precision and the relay's clock only milliseconds, so a just-published event could wait one extra poll (one second by default) before delivery.
