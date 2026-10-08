# Runbook: forensic watermarking

A forensic watermark is an invisible, keyed noise pattern added to every page image a viewer is served. The
pattern is different for every viewer and every document version. When a page turns up where it should not
(a screenshot in a chat, a photo of a screen, a re-saved image), staff upload it with the page number and the
product tests it against everyone who was served that version, giving each one a score. This runbook is for
whoever runs the install and for the workspace staff who investigate a leak: what is marked and what is not,
how to trace a leaked page or PDF, how to read the result without accusing the wrong person, and what the keys
and stored rows mean for rotation, erasure, backups and moves.

Reference material: `packages/forensic` (the
engine and its README), `packages/adapters/render-pdfium` (`embedForensicMark`, `toGray`, `watermarkPdf`)
and `modules/data-room/src/forensic/`.

## The model

- **Per document, off by default.** A document is marked only when its protection has **Forensic watermark**
  on, independent of the visible watermark: either, both or neither. A workspace can make it the default for
  new uploads (**Data room → Settings → Forensic watermark on new documents by default**,
  `forensicByDefault`), the same way the visible-watermark default works; existing documents are not changed.
  Vault documents (signed closing copies) are never forensically marked.
- **One mark per viewer per version.** The first time a membership is served a marked page (or a traced
  download) of a version, a `dataroom.forensic_mark` row is issued for (membership, version) with a random
  8-byte token. Every page of that version served to that membership carries the pattern seeded from that
  token. A new version gets new marks.
- **Everyone who views is marked**: investors, share-link visitors, delegates and staff. The mark names the
  *membership* the page was served to, nothing else.
- **"View as investor" marks the staff member, never the investor.** A page served while staff view as an
  investor shows the *investor's* visible watermark (as before) but carries the *acting staff member's own*
  invisible mark, so impersonation can never produce evidence pointing at the investor, and the copy is
  still traceable to whoever viewed it. The staff member's mark row records that it was **served under
  view-as at least once** and the **last investor viewed as** (earlier ones are not kept). Downloads stay
  refused under view-as.
- **Share links never force forensic marking.** A link's **Force watermark** forces the *visible* watermark
  for everyone bound to it (see [Upgrade note](#upgrade-note-share-link-force-watermark-is-now-enforced));
  forensic marking is decided per document only.
- **Invisible, not secret.** The pattern changes blank paper by about 2 grey levels out of 255 and text edges
  by up to 4 (PSNR 44–48 dB on real pages); readers do not see it. It is not encryption and not DRM: it does
  not stop a leak, it helps attribute one. Investors are not shown the forensic flag, but they can infer it
  (a traced download prints a `trace` line; their DSAR export lists their marks), so do not promise that
  investors cannot know.

## What is marked and what is not

| Surface | Marked? |
|---|---|
| Page images in the viewer (`GET /documents/{id}/pages/{n}`) | Yes: the invisible pattern, then the visible watermark on top if that is on |
| Thumbnails | No |
| The text layer, search snippets, copy and paste | No: text carries no mark |
| Investor download of a forensic document | Always the traced variant, never the untraced original: the vector PDF with the visible watermark if that is on, plus a visible line `trace XXXXXXXX`, tiled like the watermark (alone when the visible watermark is off), and the full token in the PDF's document information (`/SeedHostTrace`). **No invisible pattern**: the PDF stays vector |
| Download by staff who can edit the document | The original, untraced (as before) |
| Image documents downloaded as PDF | Same as a PDF: converted, then traced |

**What survives.** The detector is built for the realistic leak. Tested on real rendered pages (dense text,
a table and chart, a nearly blank page with a heading) against: the served WebP, JPEG at quality 50,
downscaling to half and back, rescaling to another width (1170 px, as on a phone, or 2000 px), cropping 5 %
off each edge, crop plus rescale plus JPEG, and another viewer's visible watermark on top. The right viewer
scored z 68–152 in every case and the best of 50 innocent candidates stayed below 3, against a match
threshold of 6.

**What does not survive (documented limits).** Rotation, perspective (a photo taken at an angle and not
straightened), print-and-scan, heavy blur or retouching, re-typing the text, copy-paste of the text layer.
Averaging copies from k viewers divides each one's score by roughly k, so a collusion of several may show as
`inconclusive` for each. Someone who knows the algorithm and has the *unmarked* page can subtract the mark;
the detector flags an inverted or subtracted mark as **tampering suspected**.

## Turning it on

1. Staff with `data-room.manage` open the document and switch **Forensic watermark** on. The change is audited
   `document.updated` like the other protection switches.
2. To mark every new upload: **Data room → Settings → Forensic watermark on new documents by default**
   (`data-room.settings`, fresh sign-in, audited `data_room.settings_changed`).
3. Nothing to configure on the install. Marks are keyed from the master key ring (below); the renderer that
   already draws the visible watermark embeds the pattern.

**Cost.** Each page is rendered once without any watermark (that raster is cached, encrypted, as before), then
marked per viewer and cached in memory per (version, page, membership, day, token, visible layer on/off).
Embedding the pattern takes about 60 ms for a 1600 × 2070 page; with the WebP decode and re-encode the renderer
spends roughly 200–550 ms per page, once per viewer per page per day. The `last_served_at` of a mark is
written at most once an hour.

## Tracing a leaked page image

Who: owner, admin or legal (`data-room.forensics`), signed in within the last 10 minutes.

1. Get the **least processed copy** you can: the original screenshot file rather than a forwarded,
   re-compressed one; a whole page rather than a crop. A phone photo works if the page fills the frame and is
   straight. The image must have the page's shape (aspect ratio within 25 % of the page) and at most 4 times
   its pixels, and be at least 200 px wide.
2. Open the document, **Forensic tracing → Trace a leak…**. Upload the image (PNG, JPEG or WebP, at most
   15 MiB), enter the **page number** it shows, and pick the **version** if it is not the current one (a leak
   of an older version must be tested against that version's recipients). A binned document can still be
   investigated.
3. Read the result (next section). The image is decoded, tested and discarded; it is never stored. The run is
   audited `data_room.forensic_detection` with the version, page, number of candidates tested and the
   membership ids that matched.

The same through the API (`multipart/form-data`, staff session with a fresh sign-in):

```
curl -s -X POST https://<host>/api/v1/data-room/documents/<documentId>/forensic/detect \
  -b "<session cookie>" -H "Origin: https://<host>" \
  -F image=@leak.png -F page=4 [-F versionId=<uuid>]
```

**Limits.** 10 detections per user per hour, across workspaces (`429 forensic_rate_limited`); refusals because
the server is busy do not count. At most 2 000 recipients per version (`422 forensic_too_many_candidates`).
Scoring runs on a worker thread, one detection at a time per server process with up to 4 waiting, and one
detection per workspace per process at a time; anything beyond that, or a detection that runs over 30
seconds, answers `503 forensic_busy` with `Retry-After: 10`. A detection normally takes 1–3 seconds.

**Recipients list.** **Forensic tracing → Recipients with a marked copy**
(`GET /documents/{id}/forensic/recipients?versionId=`) lists every membership that was served a marked copy,
with the version, when it was first and last served, its **Download trace** code, and whether it was served
under view-as. It answers "who could have leaked this version" before any image exists.

## Tracing a leaked PDF download

The visible line reads `trace XXXXXXXX`: eight base32 characters (RFC 4648) of the first five bytes of the
recipient's token. Find the row with that **Download trace** in the document's recipients list (all versions).
If the line was removed, the PDF's document information may still carry `/SeedHostTrace`, the full token in
hex; read it **from the trailer's Info dictionary only** (`exiftool -SeedHostTrace leaked.pdf`, `qpdf
--show-object=trailer`, or any PDF inspector), never from a string found elsewhere in the file. Its first five
bytes in base32 are the trace.

**The PDF trace is corroboration, not proof.** The line and the metadata are trivially removed, copied or
edited by anyone with a PDF editor, and a traced PDF that someone downloaded and later re-uploaded still
shows the original recipient's `trace` text (the product strips `/SeedHostTrace` from uploads and from every
copy it produces, but cannot remove text drawn on a page). Confirm a trace by:

- the audit log: a `document.downloaded` event by that membership for that document and version, with
  `forensic: true`;
- and, where the leak includes a rendered page image of the same document, an image detection.

Their absence proves nothing either.

**Side effect on uploads.** Sanitising an uploaded PDF that carries `/SeedHostTrace` (for example a traced
download that was then e-signed and uploaded again) rewrites the file, so a digital signature in it no longer
validates in the stored, normalised copy that viewers see. The original upload is kept untouched, and staff
who can edit still download it, signature intact. This is how sanitising already treats PDFs with JavaScript
or embedded files.

## Reading the result

For every candidate the detector computes a **z score**: how strongly the leaked page's residual (the leak
minus the clean page) correlates with that viewer's pattern. Nothing in the computation looks at a candidate
before scoring, so for anyone whose mark is *not* in the image the score is a pure chance quantity with a
proven bound: the probability that it reaches t is at most e^(−t²/2), whatever the image.

The thresholds grow with the number of candidates N, so that the chance of naming **anyone** innocent stays
fixed however large the audience:

| Verdict | Threshold | Chance that any innocent candidate gets it |
|---|---|---|
| `match` | z ≥ max(6, √(2·ln(N·10⁶))): 6 up to about 65 candidates, 6.54 at 2 000 | at most 1 in a million per detection |
| `inconclusive` | z ≥ max(4, √(2·ln(N·100))): 4.13 at 51 candidates, 4.94 at 2 000 | at most 1 in 100 per detection |
| not matched | below | — (only counted, `noMatchCount`) |

The response returns the thresholds it used; the screen shows them. **Not matched is not ruled out**: a
heavily processed copy may simply carry too little of the mark.

Also shown:

- **Alignment**: the scale and offset that registered the image onto the page, and its quality. Below 0.5
  the detection is refused as `forensic_alignment_failed` rather than scored.
- **Candidates tested**, and **keys missing**: marks whose key-ring entry is gone and could not be tested (see
  [Keys](#keys-rotation-and-loss)).
- **Tampering suspected**: some candidate scored at or below minus the match threshold, the signature of a
  mark that was inverted or subtracted on purpose. Treat the image as manipulated.
- **Served under view-as** on a result row: that staff member was served this version at least once while
  viewing as an investor (the last one is named). It does not say the leaked copy *was* the view-as copy; if
  the leak shows an investor's visible watermark but matches a staff member's mark, it was.

**Before you act on a match:**

- **A match identifies a membership, not a person.** It says the image was made from a copy served to that
  membership. A shared account, a delegate acting for the investor, an assistant at the investor's desk or a
  compromised mailbox all leave the same mark. The decision about a person is a human one.
- **Corroborate.** Test a second leaked page if there is one: two independent matches are far stronger than
  one. Look at that membership's audit trail (`document.viewed`, `document.downloaded`, sign-ins and their
  networks) and at the visible watermark if it survived.
- **More than one `match`** on one image means it combines copies (collusion or averaging). Record all of
  them; do not pick one.
- **A match against a staff membership** is as valid as any other: staff are marked when they view.
- **Record what you did.** The audit row records the run; keep the image, where it came from and your
  conclusion in the incident record, outside the product ([incident-response.md](incident-response.md)).

## Errors

| Code | Means | Fix |
|---|---|---|
| `400 validation_failed` | missing or malformed `page` or `versionId` | send a page number ≥ 1 and a version id |
| `413 payload_too_large` | the request body is over 15 MiB (plus multipart overhead) | export the image smaller, as PNG or JPEG |
| `415 unsupported_media_type` | the image part is not declared PNG, JPEG or WebP | convert it |
| `422 forensic_image_invalid` | `reason`: `empty`, `too_large` (over 15 MiB, or over 4× the page's pixels or height), `undecodable`, `too_small` (under 200 px wide), `aspect_ratio` (shape more than 25 % off the page's) | upload the whole page as captured; crop away a phone's surroundings; do not upload a thumbnail |
| `409 forensic_no_marks` | this version was never served with a mark, or every mark's key has left the key ring (`details.keysMissing`) | pick the version the leak shows; if forensic was off when it was viewed, there is nothing to trace |
| `422 forensic_alignment_failed` | the image could not be registered onto the page: wrong page number or version, rotated or skewed, cropped beyond about 8 % per edge, or not that page at all | check page and version; straighten and crop the photo to the page; try another copy |
| `422 forensic_too_many_candidates` | more than 2 000 memberships were served this version | contact the maintainers |
| `429 forensic_rate_limited` | 10 detections by this user in the last hour | wait (`Retry-After`) |
| `503 forensic_busy` | the server's detection queue is full, another detection of this workspace is running, or the detection exceeded 30 s (`reason: "timeout"`) | retry after 10 s; does not count toward the hourly limit |
| `404` | document, version or page not found | — |

On an install with several app processes, each process has its own queue and its own per-workspace slot.

## What is stored

`dataroom.forensic_mark`: one row per (workspace, membership, version) with the token, the id of the key-ring
entry it was issued under, `first_served_at` / `last_served_at`, and the view-as record (`last_view_as_at`,
`view_as_membership_id`). No name, email or address: membership ids are the only link to people.

- **Who can read it:** staff of the workspace (row-level security); externals cannot; rows are written only in
  system context. The API never returns tokens or seeds; the recipients list shows the 8-character trace.
- **DSAR access requests:** the person's export lists their marks (document, title, version, first and last
  served, trace; never the token).
- **Erasure:** mark rows are **kept**: they hold nothing but membership ids and are evidence. The membership
  itself is pseudonymised as usual, so a later detection reports the match under the pseudonymised name.
- **Purge** of a document or version deletes its marks (cascade); workspace deletion and crypto-shred delete
  them with everything else.
- **Workspace export and import, cross-cell moves:** marks are **not carried** (`instance-local`): they depend
  on this install's key ring. After a move or an import, copies served before it can no longer be traced; new
  views are marked again on the target.
- **Backups** carry the rows; a restore needs the key ring of the time, as for everything else.

## Keys, rotation and loss

The pattern seed is `HMAC-SHA256(patternKey, "mark\0" ‖ token)`, where the pattern key is derived (HKDF,
purpose `seed-host/forensic/pattern/v1`) from the key-ring entry that was **current when the mark was
issued**; the row records that entry's id. Rotating the ring ([rotate-keys.md](rotate-keys.md)) changes nothing
for existing marks: new marks use the new entry, old ones keep working while their entry stays in the ring.

**Removing an entry from the ring makes every copy marked under it untraceable.** Detection skips those marks
and reports them as `keysMissing` (and answers `409 forensic_no_marks` when none is left to test). A mark whose
entry is gone is re-issued with a new token under the current entry the next time its viewer is served, so new
copies are traceable again, but copies made before stay lost. Keep retired entries in the ring for as long as
leaks of those versions might need tracing.

## Upgrade note: share-link Force watermark is now enforced

Before forensic watermarking shipped, a share link's **Force watermark** policy was stored and shown but not applied. It now is: a
viewer bound to a live link (visit not revoked, link not revoked; a paused or expired link still forces, the
safe direction) gets the visible watermark on every page and a watermarked download, even when the document's
protection has it off. No setting is needed. Tell workspaces that relied on the old behaviour.

## Verify

1. In a test workspace, upload a PDF, switch **Forensic watermark** on, view page 1 as two different investors
   (two browsers) and take a screenshot of page 1 in one of them.
2. **Trace a leak…** with that screenshot and page 1: the investor whose browser it came from is `match` with a
   z far above the threshold, and the other is counted as not matched.
3. **Audit log** shows `data_room.forensic_detection` with that membership in `matches`.
4. Download the document as the first investor (if downloads are allowed): the PDF shows `trace XXXXXXXX`,
   and that code is the investor's **Download trace** in the recipients list.
