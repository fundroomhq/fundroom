---
"@fundroom/server": patch
"@fundroom/domain": patch
"@fundroom/sdk": patch
"@fundroom/web": patch
"@fundroom/module-notify": patch
"@fundroom/module-data-room": patch
---

An upload the virus scanner flags now alerts people instead of only being written to the audit log. The data room's ingest job publishes the new `document.scan_infected` event (ids, the uploader and the scanner's signature only), and the notify module turns it into an instant alert for staff holding `data-room.manage` and for the member who uploaded the file, linking the document in the data-room admin. One alert per file; it is never posted to a chat channel. Migration `notify/0013` adds the event type to the preference and notification CHECKs.
