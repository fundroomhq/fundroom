# @fundroom/mail

React Email templates and the templated `MailerPort` decorator. Components and `render` come
from the `react-email` package (the old `@react-email/components` is deprecated on npm).

```ts
import { createTemplatedMailer, renderTemplate, createMemoryMailer, createLogMailer } from "@fundroom/mail";

// Composition root: wrap whatever MailerPort was chosen from MAILER_DRIVER.
const mailer = createTemplatedMailer(smtp, {
  brand: (message) => brandForWorkspace(message),   // or a static EmailBrand
  log,
});

// Anywhere: render directly (previews, tests).
const { html, text } = await renderTemplate("auth.otp", { code: "123456", ttlMinutes: 10 }, brand);
```

## How templates pair with the identity kernel

`@fundroom/identity` builds plain-text `OutboundEmail`s and is the source of truth for
wording. Each builder attaches `template: { name, props }` with JSON-safe props (dates as ISO
strings); identity never imports React. `createTemplatedMailer` renders that template into
`html` when the message has none, keeps the caller's `text`, and never fails a send because of
HTML: an unknown name logs `mail.template_unknown`, a render error logs
`mail.template_failed`, and the text-only message still goes out.

| Template | Props | Built by |
|---|---|---|
| `auth.otp` | `code`, `ttlMinutes` | `otpEmail` |
| `auth.magic_link` | `url`, `code`, `ttlMinutes`, `device?` | `magicLinkEmail` |
| `auth.new_device` | `device`, `whenIso`, `revokeUrl`, `sessionsUrl` | `newDeviceEmail` |
| `auth.invite` | `url`, `inviterName?`, `message?`, `expiresOn` (`YYYY-MM-DD`) | `inviteEmail` |
| `auth.share_link_otp` | `code`, `ttlMinutes`, `label?`, `sharedBy?` | `shareLinkEmail` |
| `notification` | `title`, `paragraphs[]`, `cta?: { label, url }` | later modules |

`auth.share_link_otp` is separate from `auth.otp` rather than a variant of it, because the reader
has no account: they were handed a share link by somebody at the workspace, and "your sign-in code"
would describe something that has not happened. It names what was shared and by whom when the link
row says, and it never carries the link's **token** — the token is the secret in the URL, the code
is the secret in the message, and putting both in one email would defeat the point of having two.

Modules add their own with `registerTemplate("updates.digest", Component)` at boot.

## Brand

`EmailBrand = { productName, workspaceName?, tagline?, logoUrl?, accentColor?, supportEmail?,
addressLine?, showPoweredBy? }`. Values are untrusted workspace settings: text is escaped by
React, `accentColor` must be a hex colour and `logoUrl` an https URL or they fall back, and the
`tagline` is trimmed and capped at 160 characters (`safeBrand`, the single sanitiser). The
layout is inline-styled only — no web fonts, external CSS, scripts or tracking pixels.

`showPoweredBy: false` removes the "powered by <product>" attribution from the footer and
nothing else: the workspace line, the support address and the postal address stay, because they
are what makes a send identifiable and CAN-SPAM-compliant.

`options.brand` may be a resolver, and the resolver may be **async** — E1.7 keys it off
`message.workspaceId` and reads the workspace's `branding` settings. A synchronous resolver
could only consult an in-memory cache, so the first email after every restart would silently go
out unbranded. A resolver that throws or rejects logs `mail.brand_failed` and the message
renders with `options.defaultBrand`; branding never blocks a send.

## Test and dev mailers

- `createMemoryMailer()` records `sent`, returns synthetic ids, `failNext()` simulates an outage.
- `createLogMailer({ log })` prints recipient, subject **and the full text body** to the log —
  on purpose, for `APP_ENV=dev` without SMTP. The composition root must refuse
  it outside dev/test.
