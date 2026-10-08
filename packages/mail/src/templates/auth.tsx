import { t } from "@fundroom/i18n";
import { Button, Link, Section, Text } from "react-email";
import { brandTitle, type EmailBrand, safeBrand } from "../brand.js";
import { buttonStyle, Layout, type LocaleProps, styles } from "./layout.js";

/*
 * Auth emails. The sentences here mirror the plain-text bodies in
 * `@fundroom/identity` (`src/mail/templates.ts`), which is the source of truth for wording:
 * both render the same `@fundroom/i18n` catalogue keys, in the recipient's language
 * (`locale`, E2.8). Props are the JSON-safe `template.props` those builders attach (dates as
 * ISO strings), so identity never imports React.
 */
export interface OtpProps extends LocaleProps {
  readonly code: string;
  readonly ttlMinutes: number;
}

export function OtpEmail({ brand, code, ttlMinutes, locale }: OtpProps & { brand: EmailBrand }) {
  const title = brandTitle(brand);
  return (
    <Layout brand={brand} locale={locale} preview={t(locale, "auth.otp.subject", { code, title })}>
      <Text style={styles.text}>{t(locale, "auth.otp.intro", { title })}</Text>
      <Text style={styles.code}>{code}</Text>
      <Text style={styles.text}>{t(locale, "auth.otp.expires", { count: ttlMinutes })}</Text>
      <Text style={styles.muted}>{t(locale, "auth.otp.ignore")}</Text>
    </Layout>
  );
}

export interface MagicLinkProps extends LocaleProps {
  readonly url: string;
  readonly code: string;
  readonly ttlMinutes: number;
  readonly device?: string | undefined;
}

export function MagicLinkEmail({
  brand,
  url,
  code,
  ttlMinutes,
  device,
  locale,
}: MagicLinkProps & { brand: EmailBrand }) {
  const title = brandTitle(brand);
  const accent = safeBrand(brand).accentColor ?? "#1d4ed8";
  return (
    <Layout brand={brand} locale={locale} preview={t(locale, "auth.magic.subject", { title })}>
      <Text style={styles.text}>{t(locale, "auth.magic.intro", { title })}</Text>
      <Section>
        <Button href={url} style={buttonStyle(accent)}>
          {t(locale, "auth.magic.button")}
        </Button>
      </Section>
      <Text style={styles.urlBox}>{url}</Text>
      <Text style={styles.text}>{t(locale, "auth.magic.code_hint")}</Text>
      <Text style={styles.code}>{code}</Text>
      <Text style={styles.text}>{t(locale, "auth.magic.expires", { count: ttlMinutes })}</Text>
      {device ? (
        <Text style={styles.muted}>{t(locale, "auth.magic.device", { device })}</Text>
      ) : null}
      <Text style={styles.muted}>{t(locale, "auth.magic.ignore")}</Text>
    </Layout>
  );
}

export interface NewDeviceProps extends LocaleProps {
  readonly device: string;
  /** ISO timestamp. */
  readonly whenIso: string;
  readonly revokeUrl: string;
  readonly sessionsUrl: string;
}

export function NewDeviceEmail({
  brand,
  device,
  whenIso,
  revokeUrl,
  sessionsUrl,
  locale,
}: NewDeviceProps & { brand: EmailBrand }) {
  const title = brandTitle(brand);
  const accent = safeBrand(brand).accentColor ?? "#1d4ed8";
  return (
    <Layout brand={brand} locale={locale} preview={t(locale, "auth.device.subject", { title })}>
      <Text style={styles.text}>{t(locale, "auth.device.intro", { title })}</Text>
      <Text style={styles.detail}>{`${t(locale, "auth.device.device_label")} ${device}`}</Text>
      <Text style={{ ...styles.detail, marginBottom: "16px" }}>
        {`${t(locale, "auth.device.when_label")} ${whenIso}`}
      </Text>
      <Text style={styles.text}>{t(locale, "auth.device.ok")}</Text>
      <Text style={styles.text}>{t(locale, "auth.device.not_you")}</Text>
      <Section>
        <Button href={revokeUrl} style={buttonStyle(accent)}>
          {t(locale, "auth.device.button")}
        </Button>
      </Section>
      <Text style={styles.urlBox}>{revokeUrl}</Text>
      <Text style={styles.muted}>
        {t(locale, "auth.device.review_label")} <Link href={sessionsUrl}>{sessionsUrl}</Link>
      </Text>
    </Layout>
  );
}

export interface InviteProps extends LocaleProps {
  readonly url: string;
  readonly inviterName?: string | undefined;
  readonly message?: string | undefined;
  /** `YYYY-MM-DD`. */
  readonly expiresOn: string;
  /** E3.2: the principal a delegate invitation acts for (the invitee is told before accepting). */
  readonly delegateFor?: string | undefined;
}

export function InviteEmail({
  brand,
  url,
  inviterName,
  message,
  expiresOn,
  delegateFor,
  locale,
}: InviteProps & { brand: EmailBrand }) {
  const target = brand.workspaceName ?? brand.productName;
  const accent = safeBrand(brand).accentColor ?? "#1d4ed8";
  return (
    <Layout brand={brand} locale={locale} preview={t(locale, "auth.invite.subject", { target })}>
      <Text style={styles.text}>
        {delegateFor !== undefined
          ? t(locale, "auth.invite.intro_delegate", { principal: delegateFor, target })
          : inviterName
            ? t(locale, "auth.invite.intro_named", { inviter: inviterName, target })
            : t(locale, "auth.invite.intro", { target })}
      </Text>
      {message ? <Text style={styles.quote}>{`"${message}"`}</Text> : null}
      <Text style={styles.text}>{t(locale, "auth.invite.accept")}</Text>
      <Section>
        <Button href={url} style={buttonStyle(accent)}>
          {t(locale, "auth.invite.button")}
        </Button>
      </Section>
      <Text style={styles.urlBox}>{url}</Text>
      <Text style={styles.muted}>{t(locale, "auth.invite.expires", { date: expiresOn })}</Text>
    </Layout>
  );
}

/**
 * The sign-in code for a share-link visitor (E2.3). Separate from `auth.otp` because the
 * sentence is different: the reader was handed a link by somebody at the workspace and has
 * no account yet, so "sign in" would be a lie and "your code" needs a reason attached.
 *
 * It says who shared and what is behind the link **only when the link's own policy already
 * named this address**; a forwarded link tells its finder nothing it did not already carry.
 * The invitation itself is not the secret — the code is.
 */
export interface ShareLinkOtpProps extends LocaleProps {
  readonly code: string;
  readonly ttlMinutes: number;
  /** What the link opens, in the admin's words. Omitted when the link is unlabelled. */
  readonly label?: string | undefined;
  /** Who shared it, when the workspace chose to say. */
  readonly sharedBy?: string | undefined;
}

export function ShareLinkOtpEmail({
  brand,
  code,
  ttlMinutes,
  label,
  sharedBy,
  locale,
}: ShareLinkOtpProps & { brand: EmailBrand }) {
  const title = brandTitle(brand);
  const what = label ?? t(locale, "auth.share.what_default");
  const intro = sharedBy
    ? t(locale, "auth.share.intro_named", { sharedBy, what, title })
    : t(locale, "auth.share.intro_somebody", {
        workspace: brand.workspaceName ?? title,
        what,
        title,
      });
  return (
    <Layout
      brand={brand}
      locale={locale}
      preview={t(locale, "auth.share.subject", { code, title })}
    >
      <Text style={styles.text}>{intro}</Text>
      <Text style={styles.code}>{code}</Text>
      <Text style={styles.text}>{t(locale, "auth.otp.expires", { count: ttlMinutes })}</Text>
      <Text style={styles.muted}>{t(locale, "auth.share.ignore")}</Text>
    </Layout>
  );
}

/**
 * The verification code for a public access request (E3.1): the reader is not a member yet, so
 * the copy says "asked for access", never "sign in".
 */
export interface AccessRequestCodeProps extends LocaleProps {
  readonly code: string;
  readonly ttlMinutes: number;
  /** ISO timestamp; carried for completeness, the copy states the minutes. */
  readonly expiresAt?: string | undefined;
  /** The name (and firm) the submission gave, restated so a stranger's request is recognisable. */
  readonly name?: string | undefined;
  readonly firm?: string | undefined;
}

export function AccessRequestCodeEmail({
  brand,
  code,
  ttlMinutes,
  name,
  firm,
  locale,
}: AccessRequestCodeProps & { brand: EmailBrand }) {
  const title = brandTitle(brand);
  return (
    <Layout
      brand={brand}
      locale={locale}
      preview={t(locale, "auth.access_request.code_subject", { code, title })}
    >
      <Text style={styles.text}>{t(locale, "auth.access_request.code_intro", { title })}</Text>
      <Text style={styles.code}>{code}</Text>
      <Text style={styles.text}>{t(locale, "auth.otp.expires", { count: ttlMinutes })}</Text>
      {name ? (
        <Text style={styles.text}>
          {firm
            ? t(locale, "auth.access_request.code_submitted_firm", { name, firm })
            : t(locale, "auth.access_request.code_submitted", { name })}
        </Text>
      ) : null}
      <Text style={styles.muted}>{t(locale, "auth.access_request.code_ignore")}</Text>
    </Layout>
  );
}

/** "You already have access" (E3.1): sent instead of a code to a member's or invitee's address. */
export interface AccessRequestExistingProps extends LocaleProps {
  readonly signInUrl: string;
}

export function AccessRequestExistingEmail({
  brand,
  signInUrl,
  locale,
}: AccessRequestExistingProps & { brand: EmailBrand }) {
  const title = brandTitle(brand);
  const accent = safeBrand(brand).accentColor ?? "#1d4ed8";
  return (
    <Layout
      brand={brand}
      locale={locale}
      preview={t(locale, "auth.access_request.existing_subject", { title })}
    >
      <Text style={styles.text}>{t(locale, "auth.access_request.existing_intro", { title })}</Text>
      <Text style={styles.text}>{t(locale, "auth.access_request.existing_action")}</Text>
      <Section>
        <Button href={signInUrl} style={buttonStyle(accent)}>
          {t(locale, "auth.access_request.existing_button")}
        </Button>
      </Section>
      <Text style={styles.urlBox}>{signInUrl}</Text>
      <Text style={styles.muted}>{t(locale, "auth.access_request.existing_ignore")}</Text>
    </Layout>
  );
}

/** The neutral answer to a denied access request (E3.1). No reason, never the staff note. */
export type AccessRequestDeniedProps = LocaleProps;

export function AccessRequestDeniedEmail({
  brand,
  locale,
}: AccessRequestDeniedProps & { brand: EmailBrand }) {
  const target = brand.workspaceName ?? brand.productName;
  return (
    <Layout
      brand={brand}
      locale={locale}
      preview={t(locale, "auth.access_request.denied_subject", { target })}
    >
      <Text style={styles.text}>{t(locale, "auth.access_request.denied_body", { target })}</Text>
      <Text style={styles.muted}>{t(locale, "auth.access_request.denied_footer")}</Text>
    </Layout>
  );
}
