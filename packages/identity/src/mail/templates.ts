import { type MessageKey, t } from "@fundroom/i18n";
import type { OutboundEmail } from "@fundroom/ports";

/*
 * Plain-text auth emails: the copy here is the source of truth for wording. Each message
 * also names the `@fundroom/mail` template (`template: { name, props }`) that renders the
 * HTML version of the same sentences; `createTemplatedMailer` in the composition root fills
 * `html` from it, and a mailer without templates just sends the text. Props are JSON-safe
 * (dates as ISO strings) so this package never imports React. Never include anything an
 * attacker could use beyond the code/link itself (no account state, no "you have N
 * workspaces").
 */
export interface EmailBrand {
  readonly productName: string;
  readonly workspaceName?: string | undefined;
  /**
   * Workspace the message is sent on behalf of (E1.7). Every template below copies it onto the
   * `OutboundEmail` so the composition root's brand resolver can look the workspace's branding
   * settings up by it. It rides on `EmailBrand` rather than on each template's own props
   * because the flows that know a workspace already pass `workspaceName` from the very same
   * place, so there is nothing new to thread. Leave it undefined for host-level sign-in (no
   * workspace is resolved yet): the resolver then renders the instance brand, which is right,
   * whereas guessing an id would put the wrong company's logo on a sign-in code.
   */
  readonly workspaceId?: string | undefined;
  /**
   * The recipient's language (E2.8): `user.locale ?? workspace.default_locale ?? "en"`, picked
   * by the flow that knows the recipient (`recipientLocale`). Absent = `en`. It is copied onto
   * `template.props.locale` so the HTML part renders in the same language as the text.
   */
  readonly locale?: string | undefined;
}

/** `t` for one message's language. */
function tr(input: EmailBrand) {
  return (key: MessageKey, vars?: Readonly<Record<string, string | number>>) =>
    t(input.locale, key, vars);
}

/** `template.props.locale` only when a language was chosen, so `en` props stay as they were. */
function localeProp(input: EmailBrand): { locale?: string } {
  return input.locale === undefined ? {} : { locale: input.locale };
}

function title(brand: EmailBrand): string {
  return brand.workspaceName ? `${brand.workspaceName} (${brand.productName})` : brand.productName;
}

export function otpEmail(
  to: string,
  input: EmailBrand & { code: string; ttlMinutes: number },
): OutboundEmail {
  const m = tr(input);
  const text = [
    m("auth.otp.intro", { title: title(input) }),
    "",
    `    ${input.code}`,
    "",
    m("auth.otp.expires", { count: input.ttlMinutes }),
    m("auth.otp.ignore"),
  ].join("\n");
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.otp.subject", { code: input.code, title: title(input) }),
    text,
    template: {
      name: "auth.otp",
      props: { code: input.code, ttlMinutes: input.ttlMinutes, ...localeProp(input) },
    },
    tags: ["auth", "otp"],
  };
}

/**
 * The access code for a share-link visitor (E2.3).
 *
 * Separate from `otpEmail` because the sentences are different, and because the wording carries a
 * compliance consequence: the reader has no account, was handed a link by somebody at the
 * workspace, and "sign in" would describe something that has not happened yet. As with every
 * template here, this text is the wording of record — `@fundroom/mail`'s `auth.share_link_otp`
 * only renders the same sentences as HTML.
 *
 * `label` and `sharedBy` are optional and come from the link row. They say no more than the
 * person who was sent the link already knows, and a link that names neither still sends a
 * perfectly good code. `workspaceId` rides along so the E1.7 brand resolver can find the
 * workspace's branding.
 */
export function shareLinkEmail(
  to: string,
  input: EmailBrand & {
    code: string;
    ttlMinutes: number;
    label?: string | undefined;
    sharedBy?: string | undefined;
  },
): OutboundEmail {
  const m = tr(input);
  const what = input.label ?? m("auth.share.what_default");
  const intro = input.sharedBy
    ? m("auth.share.intro_named", { sharedBy: input.sharedBy, what, title: title(input) })
    : m("auth.share.intro_somebody", {
        workspace: input.workspaceName ?? title(input),
        what,
        title: title(input),
      });
  const text = [
    intro,
    "",
    `    ${input.code}`,
    "",
    m("auth.otp.expires", { count: input.ttlMinutes }),
    m("auth.share.ignore"),
  ].join("\n");
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.share.subject", { code: input.code, title: title(input) }),
    text,
    template: {
      name: "auth.share_link_otp",
      props: {
        code: input.code,
        ttlMinutes: input.ttlMinutes,
        label: input.label,
        sharedBy: input.sharedBy,
        ...localeProp(input),
      },
    },
    tags: ["auth", "share-link"],
  };
}

export function magicLinkEmail(
  to: string,
  input: EmailBrand & {
    url: string;
    code: string;
    ttlMinutes: number;
    device?: string | undefined;
  },
): OutboundEmail {
  const m = tr(input);
  const text = [
    m("auth.magic.intro", { title: title(input) }),
    "",
    `    ${input.url}`,
    "",
    m("auth.magic.code_hint"),
    "",
    `    ${input.code}`,
    "",
    m("auth.magic.expires", { count: input.ttlMinutes }),
    input.device ? m("auth.magic.device", { device: input.device }) : "",
    m("auth.magic.ignore"),
  ]
    .filter((l) => l !== "")
    .join("\n");
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.magic.subject", { title: title(input) }),
    text,
    template: {
      name: "auth.magic_link",
      props: {
        url: input.url,
        code: input.code,
        ttlMinutes: input.ttlMinutes,
        device: input.device,
        ...localeProp(input),
      },
    },
    tags: ["auth", "magic-link"],
  };
}

export function newDeviceEmail(
  to: string,
  input: EmailBrand & { device: string; when: Date; revokeUrl: string; sessionsUrl: string },
): OutboundEmail {
  const m = tr(input);
  // The two labels are padded to one width so the values line up in a monospace client.
  const deviceLabel = m("auth.device.device_label");
  const whenLabel = m("auth.device.when_label");
  const width = Math.max(deviceLabel.length, whenLabel.length);
  const text = [
    m("auth.device.intro", { title: title(input) }),
    "",
    `    ${deviceLabel.padEnd(width)} ${input.device}`,
    `    ${whenLabel.padEnd(width)} ${input.when.toISOString()}`,
    "",
    m("auth.device.ok"),
    m("auth.device.not_you"),
    "",
    `    ${input.revokeUrl}`,
    "",
    `${m("auth.device.review_label")} ${input.sessionsUrl}`,
  ].join("\n");
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.device.subject", { title: title(input) }),
    text,
    template: {
      name: "auth.new_device",
      props: {
        device: input.device,
        whenIso: input.when.toISOString(),
        revokeUrl: input.revokeUrl,
        sessionsUrl: input.sessionsUrl,
        ...localeProp(input),
      },
    },
    tags: ["auth", "new-device"],
  };
}

export function inviteEmail(
  to: string,
  input: EmailBrand & {
    url: string;
    inviterName?: string | undefined;
    message?: string | undefined;
    expiresAt: Date;
    /**
     * E3.2: the principal's name on a delegate invitation. The invitee is told, before accepting,
     * whom they would act for (consent by information).
     */
    delegateFor?: string | undefined;
  },
): OutboundEmail {
  const m = tr(input);
  const target = input.workspaceName ?? input.productName;
  const text = [
    input.delegateFor !== undefined
      ? m("auth.invite.intro_delegate", { principal: input.delegateFor, target })
      : input.inviterName
        ? m("auth.invite.intro_named", { inviter: input.inviterName, target })
        : m("auth.invite.intro", { target }),
    "",
    input.message ? `"${input.message}"\n` : "",
    m("auth.invite.accept"),
    "",
    `    ${input.url}`,
    "",
    m("auth.invite.expires", { date: input.expiresAt.toISOString().slice(0, 10) }),
  ]
    .filter((l) => l !== "")
    .join("\n");
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.invite.subject", { target }),
    text,
    template: {
      name: "auth.invite",
      props: {
        url: input.url,
        inviterName: input.inviterName,
        message: input.message,
        expiresOn: input.expiresAt.toISOString().slice(0, 10),
        ...(input.delegateFor === undefined ? {} : { delegateFor: input.delegateFor }),
        ...localeProp(input),
      },
    },
    tags: ["auth", "invite"],
  };
}

/**
 * The verification code for a public access request (E3.1). The reader is not a member, so the
 * copy says "asked for access", never "sign in". Nothing else about the request (name, firm,
 * reason) is echoed back: whoever triggered it may not own the mailbox.
 */
export function accessRequestCodeEmail(
  to: string,
  input: EmailBrand & {
    code: string;
    ttlMinutes: number;
    expiresAt: Date;
    /** What THIS submission said, restated so the mailbox's owner can tell it was not them. */
    name: string;
    firm?: string | null | undefined;
  },
): OutboundEmail {
  const m = tr(input);
  const text = [
    m("auth.access_request.code_intro", { title: title(input) }),
    "",
    `    ${input.code}`,
    "",
    m("auth.otp.expires", { count: input.ttlMinutes }),
    input.firm
      ? m("auth.access_request.code_submitted_firm", { name: input.name, firm: input.firm })
      : m("auth.access_request.code_submitted", { name: input.name }),
    m("auth.access_request.code_ignore"),
  ].join("\n");
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.access_request.code_subject", { code: input.code, title: title(input) }),
    text,
    template: {
      name: "auth.access_request_code",
      props: {
        code: input.code,
        ttlMinutes: input.ttlMinutes,
        expiresAt: input.expiresAt.toISOString(),
        name: input.name,
        ...(input.firm ? { firm: input.firm } : {}),
        ...localeProp(input),
      },
    },
    tags: ["auth", "access-request"],
  };
}

/**
 * "You already have access" (E3.1): what an access request from a member's (or an invitee's)
 * address sends instead of a code. The HTTP answer is the same as for anybody else; only the
 * mailbox's owner learns that the address is known here.
 */
export function accessRequestExistingEmail(
  to: string,
  input: EmailBrand & { signInUrl: string },
): OutboundEmail {
  const m = tr(input);
  const text = [
    m("auth.access_request.existing_intro", { title: title(input) }),
    "",
    m("auth.access_request.existing_action"),
    "",
    `    ${input.signInUrl}`,
    "",
    m("auth.access_request.existing_ignore"),
  ].join("\n");
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.access_request.existing_subject", { title: title(input) }),
    text,
    template: {
      name: "auth.access_request_existing",
      props: { signInUrl: input.signInUrl, ...localeProp(input) },
    },
    tags: ["auth", "access-request"],
  };
}

/**
 * The neutral "not at this time" answer to a denied access request (E3.1). It never carries the
 * staff decision note, and gives no reason.
 */
export function accessRequestDeniedEmail(to: string, input: EmailBrand): OutboundEmail {
  const m = tr(input);
  const target = input.workspaceName ?? input.productName;
  const text = [
    m("auth.access_request.denied_body", { target }),
    "",
    m("auth.access_request.denied_footer"),
  ].join("\n");
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.access_request.denied_subject", { target }),
    text,
    template: { name: "auth.access_request_denied", props: { ...localeProp(input) } },
    tags: ["auth", "access-request"],
  };
}

/** Compact, non-identifying device summary from a User-Agent string. */
export function describeUserAgent(ua: string | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//u.test(ua)
    ? "Edge"
    : /OPR\//u.test(ua)
      ? "Opera"
      : /Firefox\//u.test(ua)
        ? "Firefox"
        : /Chrome\//u.test(ua)
          ? "Chrome"
          : /Safari\//u.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad/u.test(ua)
    ? "iOS"
    : /Android/u.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/u.test(ua)
        ? "macOS"
        : /Windows/u.test(ua)
          ? "Windows"
          : /Linux/u.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

/** A change to how an account signs in (P2-01): what the security notice reports. */
export type FactorChange =
  | "totp_enabled"
  | "totp_disabled"
  | "passkey_added"
  | "passkey_removed"
  | "password_set"
  | "password_changed"
  | "password_removed"
  | "recovery_codes_regenerated";

const FACTOR_CHANGE_KEYS: Readonly<Record<FactorChange, MessageKey>> = {
  totp_enabled: "auth.factor.totp_enabled",
  totp_disabled: "auth.factor.totp_disabled",
  passkey_added: "auth.factor.passkey_added",
  passkey_removed: "auth.factor.passkey_removed",
  password_set: "auth.factor.password_set",
  password_changed: "auth.factor.password_changed",
  password_removed: "auth.factor.password_removed",
  recovery_codes_regenerated: "auth.factor.recovery_codes_regenerated",
};

/**
 * "Your sign-in methods changed" (P2-01): sent after every second-factor or password change, so
 * that somebody who took over a mailbox cannot quietly swap the authenticator. Rendered with the
 * generic `notification` template (title, paragraphs, a call to action).
 */
export function factorChangeEmail(
  to: string,
  input: EmailBrand & {
    change: FactorChange;
    device: string;
    when: Date;
    sessionsUrl: string;
    signedOutOthers: number;
  },
): OutboundEmail {
  const m = tr(input);
  const t = title(input);
  const heading = m("auth.factor.title", { title: t });
  const paragraphs = [
    m(FACTOR_CHANGE_KEYS[input.change], { title: t }),
    m("auth.factor.details", { device: input.device, when: input.when.toISOString() }),
    ...(input.signedOutOthers > 0
      ? [m("auth.factor.signed_out", { count: input.signedOutOthers })]
      : []),
    m("auth.factor.ok"),
    m("auth.factor.not_you"),
  ];
  const cta = { label: m("auth.factor.button"), url: input.sessionsUrl };
  return {
    to,
    workspaceId: input.workspaceId,
    subject: m("auth.factor.subject", { title: t }),
    text: [...paragraphs, "", `    ${input.sessionsUrl}`].join("\n\n").replace(/\n{3,}/gu, "\n\n"),
    template: {
      name: "notification",
      props: { title: heading, paragraphs, cta, ...localeProp(input) },
    },
    tags: ["auth", "security-notice"],
  };
}
