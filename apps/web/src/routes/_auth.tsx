import { Card, CardContent, ThemeToggle } from "@fundroomhq/ui";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { FooterLinks } from "../components/footer.js";
import { useWebConfig } from "../lib/config-context.js";
import { m } from "../paraglide/messages.js";

/** Centred card for every signed-out screen (login, verify, magic link, step-up, invite). */
export const Route = createFileRoute("/_auth")({ component: AuthLayout });

function AuthLayout() {
  const config = useWebConfig();
  const embed = config.tree === "embed";
  return (
    <div className={embed ? "p-4" : "flex min-h-svh flex-col bg-muted/30 p-4 sm:p-8"}>
      <a
        href="#auth-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2"
      >
        {m.nav_skip_to_content()}
      </a>
      <header className="mx-auto flex w-full max-w-md items-center justify-between py-2">
        <span className="text-sm font-semibold">
          {config.workspace?.name ?? config.instanceName}
        </span>
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
      </header>
      <main id="auth-main" className="mx-auto flex w-full max-w-md flex-1 items-start py-4">
        <Card className="w-full">
          <CardContent className="pt-6">
            <Outlet />
          </CardContent>
        </Card>
      </main>
      {embed ? null : (
        // The host's links only on the canonical host: a workspace's sign-in is its investors'.
        <FooterLinks
          className="mx-auto w-full max-w-md py-2"
          center
          hostLinks={config.workspace === null}
        />
      )}
    </div>
  );
}
