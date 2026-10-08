import { Button, Heading, Section, Text } from "react-email";
import { type EmailBrand, safeBrand } from "../brand.js";
import { buttonStyle, Layout, type LocaleProps, styles } from "./layout.js";

/**
 * Generic notification for later modules (updates digests, access requests, …): a title,
 * paragraphs and an optional call to action. Modules that need richer layouts add their own
 * template under their name and register it with `createTemplatedMailer`.
 */
export interface NotificationProps extends LocaleProps {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly cta?: { readonly label: string; readonly url: string } | undefined;
}

export function NotificationEmail({
  brand,
  title,
  paragraphs,
  cta,
  locale,
}: NotificationProps & { brand: EmailBrand }) {
  const accent = safeBrand(brand).accentColor ?? "#1d4ed8";
  return (
    <Layout brand={brand} locale={locale} preview={title}>
      <Heading as="h1" style={{ fontSize: "20px", color: "#111827", margin: "0 0 16px" }}>
        {title}
      </Heading>
      {paragraphs.map((p, i) => (
        // Paragraph order is the identity; the list is rendered once, never reconciled.
        <Text key={`${i}:${p.slice(0, 16)}`} style={styles.text}>
          {p}
        </Text>
      ))}
      {cta ? (
        <Section>
          <Button href={cta.url} style={buttonStyle(accent)}>
            {cta.label}
          </Button>
          <Text style={styles.urlBox}>{cta.url}</Text>
        </Section>
      ) : null}
    </Layout>
  );
}
