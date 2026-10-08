import { Alert, AlertDescription, AlertTitle, Button, PageHeader } from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CircleCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import * as z from "zod/mini";
import { SsoConnectionCard } from "../../../components/sso-admin/connection.js";
import { SsoDomainsCard } from "../../../components/sso-admin/domains.js";
import { ScimCard } from "../../../components/sso-admin/scim.js";
import { useBootstrap } from "../../../lib/queries.js";
import { describeTestResult, SSO_KEY } from "../../../lib/sso-queries.js";
import { m } from "../../../paraglide/messages.js";

/*
 * `?sso_test=ok|<code>` is where a test sign-in lands (the server's finish redirect). The
 * value only picks a sentence from a fixed list; it is read once and stripped from the URL so
 * a reload does not replay the banner.
 */
const searchSchema = z.object({ sso_test: z.catch(z.optional(z.string()), undefined) });

export const Route = createFileRoute("/admin/sso/")({
  validateSearch: searchSchema,
  component: SsoPage,
});

/*
 * Staff single sign-on and SCIM provisioning (E3.8, ADR-0056). A kernel screen, like
 * accreditation: enforcement is read by the tenant resolver on every staff request and the
 * sign-in flow runs before any module is enabled.
 */
function SsoPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("sso.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.sso_admin_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <SsoScreen canManage={permissions.includes("sso.manage")} />;
}

function SsoScreen({ canManage }: { canManage: boolean }) {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<string | undefined>(search.sso_test);
  useEffect(() => {
    if (search.sso_test === undefined) return;
    setTestResult(search.sso_test);
    // The test updated `lastTestedAt` / `lastError`: show them fresh.
    void queryClient.invalidateQueries({ queryKey: SSO_KEY });
    void navigate({ to: "/admin/sso", search: {}, replace: true });
  }, [search.sso_test, navigate, queryClient]);
  const result = testResult === undefined ? undefined : describeTestResult(testResult);
  return (
    <div className="space-y-6">
      <PageHeader title={m.sso_nav()} description={m.sso_admin_subtitle()} />
      {canManage ? null : (
        <p className="text-sm text-muted-foreground">{m.sso_admin_read_only()}</p>
      )}
      {result === undefined ? null : (
        <Alert
          variant={result.ok ? "success" : "destructive"}
          role={result.ok ? "status" : "alert"}
        >
          {result.ok ? <CircleCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          <AlertTitle>
            {result.ok ? m.sso_admin_test_ok_title() : m.sso_admin_test_failed_title()}
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{result.body}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setTestResult(undefined)}
            >
              {m.sso_admin_test_dismiss()}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <SsoConnectionCard canManage={canManage} />
      <SsoDomainsCard canManage={canManage} />
      <ScimCard canManage={canManage} />
    </div>
  );
}
