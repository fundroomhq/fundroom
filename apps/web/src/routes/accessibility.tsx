import { LoadingState, ThemeToggle } from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorAlert } from "../components/error-alert.js";
import { FooterLinks } from "../components/footer.js";
import { accessibilityStatementQuery } from "../lib/accessibility-queries.js";
import { useWebConfig } from "../lib/config-context.js";
import { formatDate } from "../lib/format.js";
import { Markdown } from "../lib/markdown.js";
import { useMe } from "../lib/queries.js";
import { m } from "../paraglide/messages.js";

/*
 * The workspace's accessibility statement (E2.8), public at `/accessibility`. It sits outside
 * both the portal and the signed-out card layouts on purpose: it must be readable without an
 * account (it is how somebody who cannot sign in finds out whom to ask for help), and it is a
 * long document that a narrow sign-in card would cramp. Signed-in readers get a way back to
 * the portal; everybody else a way to sign in.
 */
export const Route = createFileRoute("/accessibility")({ component: AccessibilityPage });

/**
 * The statement's own top heading repeats the page title, which the page's `<h1>` already says.
 * Drop it and lift the section headings one level, so the outline reads h1 → h2 → h3 rather
 * than jumping from the title straight to a third level.
 */
function withoutTitleHeading(body: string, title: string): string {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => line.trim() === `# ${title.trim()}`);
  if (index === -1) return body;
  const rest = [...lines.slice(0, index), ...lines.slice(index + 1)];
  if (rest.some((line) => /^# /u.test(line))) return rest.join("\n");
  return rest.map((line) => (/^#{2,3} /u.test(line) ? line.slice(1) : line)).join("\n");
}

function AccessibilityPage() {
  const config = useWebConfig();
  const embed = config.tree === "embed";
  const me = useMe();
  const statement = useQuery(accessibilityStatementQuery);
  const signedIn = me.data !== null && me.data !== undefined;
  return (
    <div className={embed ? "p-4" : "flex min-h-svh flex-col bg-muted/30 p-4 sm:p-8"}>
      <a
        href="#accessibility-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2"
      >
        {m.nav_skip_to_content()}
      </a>
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 py-2">
        <span className="text-sm font-semibold">
          {config.workspace?.name ?? config.instanceName}
        </span>
        <div className="flex items-center gap-2 text-sm">
          {me.isPending ? null : signedIn ? (
            <Link to="/" className="underline underline-offset-4">
              {m.accessibility_back_to_portal()}
            </Link>
          ) : (
            <Link to="/login" className="underline underline-offset-4">
              {m.accessibility_sign_in()}
            </Link>
          )}
          {embed ? null : (
            <ThemeToggle
              labels={{
                light: m.theme_light(),
                dark: m.theme_dark(),
                system: m.theme_system(),
                toggle: m.theme_toggle(),
              }}
            />
          )}
        </div>
      </header>
      <main
        id="accessibility-main"
        tabIndex={-1}
        className="mx-auto w-full max-w-3xl flex-1 rounded-xl border bg-background p-6 outline-none sm:p-8"
      >
        {statement.isPending ? (
          <LoadingState lines={6} label={m.common_loading()} />
        ) : statement.isError ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold tracking-tight">
              {m.accessibility_title()}
            </h1>
            <ErrorAlert error={statement.error} />
          </>
        ) : (
          <article className="space-y-4">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">{statement.data.title}</h1>
              <p className="text-sm text-muted-foreground">
                {statement.data.version === null
                  ? m.accessibility_meta_default({
                      date: formatDate(statement.data.effectiveDate),
                    })
                  : m.accessibility_meta_published({
                      date: formatDate(statement.data.effectiveDate),
                      version: String(statement.data.version),
                    })}
              </p>
            </header>
            <Markdown
              source={withoutTitleHeading(statement.data.bodyMarkdown, statement.data.title)}
              className="space-y-3 text-sm leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_h2]:pt-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:pt-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
            />
          </article>
        )}
      </main>
      <div className="mx-auto w-full max-w-3xl">
        <FooterLinks className="py-4" center hostLinks={config.workspace === null} />
      </div>
    </div>
  );
}
