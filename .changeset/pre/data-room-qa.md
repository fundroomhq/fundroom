---
"@fundroom/module-data-room": minor
"@fundroom/module-notify": minor
"@fundroom/domain": minor
"@fundroom/authz": minor
"@fundroom/csv": minor
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
"@fundroom/mail": patch
---

Add data-room Q&A, off by default (`dataRoom.qa.enabled`). Investors can ask a question about a document or folder they can view. Each thread is private to its asker until staff publish it, and then everyone who can view the target sees a public wording the coordinator controls, never who asked or their original words. Staff get a Questions inbox with status tabs, assignment, due times and SLA badges. The work is split across three new permissions: `data-room.qa_answer` (expert), `data-room.qa_manage` (coordinator) and `data-room.qa_approve` (approver). Optional four-eyes approval is pinned to the exact answer text, and a changed released answer goes offline until it is approved again. A 15-minute SLA job sends due-soon and overdue reminders. Notify alerts coordinators, assignees, approvers and askers without quoting any question text. Published answers are searchable by exactly the people who can view the target. CSV import (all-or-nothing, dry run, 500 rows / 1 MiB) and a closing-record CSV export are included. Erasure, DSAR export and workspace portability cover the new data. `PATCH /data-room/settings` now merges under a row lock, so concurrent edits no longer overwrite each other. `@fundroom/csv` gains `parseCsvRecords` (cells plus the line each record starts on). Migrations: data-room `0003_qa`, notify `0009_qa_event_types`. The memory test mailer's `failNext` takes an optional recipient, so a concurrent mail cannot absorb a simulated failure.
