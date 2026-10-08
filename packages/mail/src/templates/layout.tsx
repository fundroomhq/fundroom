import { BASE_LOCALE, matchLocale, t } from "@fundroom/i18n";
import type { ReactNode } from "react";
import { Body, Container, Head, Hr, Html, Img, Link, Preview, Section, Text } from "react-email";
import { type EmailBrand, safeBrand } from "../brand.js";

/*
 * Shared frame for every transactional email. Deliberately plain: inline styles only, no
 * web fonts, no external CSS, no images other than the workspace logo, no tracking pixel
 * (design/02 §7: first-party analytics only, none in auth mail). Dark-mode clients invert
 * the palette themselves; we keep contrast high enough either way.
 */
export interface LayoutProps {
  readonly brand: EmailBrand;
  /** Preheader shown next to the subject in inbox lists. */
  readonly preview: string;
  readonly children: ReactNode;
  /** The recipient's language (E2.8); `<html lang>` and the footer follow it. Default `en`. */
  readonly locale?: string | undefined;
}

/** Every template's props may carry the recipient's language (`template.props.locale`). */
export interface LocaleProps {
  readonly locale?: string | undefined;
}

/** The `lang` attribute for a locale: a supported tag, else `en`. */
export function langOf(locale: string | undefined): string {
  return matchLocale(locale) ?? BASE_LOCALE;
}

export const styles = {
  body: { backgroundColor: "#f4f5f7", fontFamily: "Helvetica, Arial, sans-serif", margin: 0 },
  container: {
    backgroundColor: "#ffffff",
    margin: "24px auto",
    padding: "32px",
    maxWidth: "560px",
    borderRadius: "6px",
  },
  header: { paddingBottom: "16px", marginBottom: "24px" },
  brandName: { fontSize: "18px", fontWeight: 700, color: "#111827", margin: 0 },
  tagline: { fontSize: "13px", lineHeight: "18px", color: "#6b7280", margin: "4px 0 0" },
  text: { fontSize: "16px", lineHeight: "24px", color: "#111827", margin: "0 0 16px" },
  muted: { fontSize: "13px", lineHeight: "20px", color: "#6b7280", margin: "0 0 8px" },
  code: {
    fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "28px",
    letterSpacing: "6px",
    fontWeight: 700,
    color: "#111827",
    margin: "8px 0 24px",
  },
  urlBox: {
    fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "13px",
    lineHeight: "20px",
    color: "#374151",
    wordBreak: "break-all" as const,
    backgroundColor: "#f4f5f7",
    padding: "12px",
    borderRadius: "4px",
    margin: "0 0 16px",
  },
  quote: {
    fontSize: "16px",
    lineHeight: "24px",
    color: "#374151",
    borderLeft: "3px solid #d1d5db",
    paddingLeft: "12px",
    margin: "0 0 16px",
    fontStyle: "italic",
  },
  detail: { fontSize: "15px", lineHeight: "22px", color: "#111827", margin: "0 0 4px" },
  footer: { fontSize: "12px", lineHeight: "18px", color: "#6b7280", margin: "0 0 4px" },
} as const;

export function buttonStyle(accent: string) {
  return {
    display: "inline-block",
    backgroundColor: accent,
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: 600,
    textDecoration: "none",
    padding: "12px 20px",
    borderRadius: "4px",
    margin: "0 0 24px",
  } as const;
}

export function Layout(props: LayoutProps) {
  const brand = safeBrand(props.brand);
  const accent = brand.accentColor ?? "#1d4ed8";
  const title = brand.workspaceName ?? brand.productName;
  /*
   * `showPoweredBy: false` (E1.7) removes the attribution to us and nothing else. The
   * workspace line survives on its own so the recipient still sees who sent this; the
   * support address and the postal line below are never dropped, because they are what
   * keeps a bulk send lawful and answerable and they are not the workspace's to hide.
   * With no workspace and no attribution the whole line goes: "Sent by <product>." IS
   * the attribution, so there is nothing left to say.
   */
  const locale = props.locale;
  const lang = langOf(locale);
  const footerLine = brand.workspaceName
    ? brand.showPoweredBy === false
      ? t(locale, "mail.footer.workspace", { workspace: brand.workspaceName })
      : t(locale, "mail.footer.powered_by", {
          workspace: brand.workspaceName,
          product: brand.productName,
        })
    : brand.showPoweredBy === false
      ? undefined
      : t(locale, "mail.footer.sent_by_product", { product: brand.productName });
  return (
    <Html lang={lang}>
      <Head />
      <Preview>{props.preview}</Preview>
      {/* react-email defaults the body's lang to "en"; only other languages are passed, so an
          English email stays byte-identical to what it was before E2.8. */}
      <Body {...(lang === "en" ? {} : { lang })} style={styles.body}>
        <Container style={styles.container}>
          <Section style={{ ...styles.header, borderBottom: `3px solid ${accent}` }}>
            {brand.logoUrl ? (
              <Img src={brand.logoUrl} alt={title} height="40" style={{ marginBottom: "8px" }} />
            ) : null}
            <Text style={styles.brandName}>{title}</Text>
            {brand.tagline ? <Text style={styles.tagline}>{brand.tagline}</Text> : null}
          </Section>
          {props.children}
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0 16px" }} />
          {footerLine ? <Text style={styles.footer}>{footerLine}</Text> : null}
          {brand.supportEmail ? (
            <Text style={styles.footer}>
              {t(locale, "mail.footer.questions")}{" "}
              <Link href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</Link>
            </Text>
          ) : null}
          {brand.addressLine ? <Text style={styles.footer}>{brand.addressLine}</Text> : null}
        </Container>
      </Body>
    </Html>
  );
}
