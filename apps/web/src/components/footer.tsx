import { cn } from "@fundroomhq/ui";
import { Link } from "@tanstack/react-router";
import type { WebConfig } from "../lib/config.js";
import { useWebConfig } from "../lib/config-context.js";
import { m } from "../paraglide/messages.js";

/**
 * The footer links every page carries (E2.8): the accessibility statement, and — on pages for
 * the host's own customers (`hostLinks`, A-5) — the host's terms, privacy notice, support and
 * status page first, when the install names them (`config.links`). Investors are the
 * workspace's audience, not the host's, so the portal and a workspace host's sign-in pages leave
 * the host's links out. Rendered by the shells under the page and by the public layouts. The
 * links stay underlined: they sit in running text, not in a nav bar.
 */
export function FooterLinks({
  className,
  center = false,
  hostLinks = false,
}: {
  className?: string;
  center?: boolean;
  /** Show the host's links: admin, signup, setup, the operator console, the canonical host. */
  hostLinks?: boolean;
}) {
  const config = useWebConfig();
  return (
    <footer className={cn("text-xs text-muted-foreground", className)}>
      <nav aria-label={m.footer_nav_label()}>
        <ul className={cn("flex flex-wrap gap-4", center && "justify-center")}>
          {(hostLinks ? linksOf(config.links) : []).map((link) => (
            <li key={link.key}>
              <a href={link.href} className="underline underline-offset-4">
                {link.label}
              </a>
            </li>
          ))}
          <li>
            <Link to="/accessibility" className="underline underline-offset-4">
              {m.footer_accessibility()}
            </Link>
          </li>
        </ul>
      </nav>
    </footer>
  );
}

/**
 * The host's links in footer order, only those set. The server validates them (absolute https,
 * http on localhost, mailto for support); this keeps anything else out of an `href` all the same.
 */
function linksOf(links: WebConfig["links"]): { key: string; href: string; label: string }[] {
  if (links === undefined) return [];
  const all = [
    { key: "terms", href: links.terms, label: m.footer_terms() },
    { key: "privacy", href: links.privacy, label: m.footer_privacy() },
    { key: "support", href: links.support, label: m.footer_support() },
    { key: "status", href: links.status, label: m.footer_status() },
  ];
  return all.flatMap((link) =>
    link.href !== null && isLinkable(link.href) ? [{ ...link, href: link.href }] : [],
  );
}

/** An `http(s):` or `mailto:` URL — the only kinds a footer or terms link may point at. */
export function isLinkable(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}
