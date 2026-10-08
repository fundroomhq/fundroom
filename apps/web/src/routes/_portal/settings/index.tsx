import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { createFileRoute } from "@tanstack/react-router";
import { TransparencyNotice } from "../../../components/analytics/transparency-notice.js";
import { MySignedDocuments } from "../../../components/esign/my-signed-documents.js";
import { LanguageCard } from "../../../components/language.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { useBootstrap, useMe } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/_portal/settings/")({ component: Profile });

function Profile() {
  const config = useWebConfig();
  const me = useMe();
  const bootstrap = useBootstrap();
  if (!me.data) return null;
  const user = me.data.session.user;
  const here = bootstrap.data?.workspace;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{m.profile_title()}</CardTitle>
          <CardDescription>{m.profile_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{m.profile_display_name()}</dt>
            <dd>{user.displayName}</dd>
            <dt className="text-muted-foreground">{m.profile_mfa()}</dt>
            <dd>
              {user.mfaEnrolled ? (
                <Badge variant="success">{m.profile_mfa_on()}</Badge>
              ) : (
                <Badge variant="outline">{m.profile_mfa_off()}</Badge>
              )}
            </dd>
            <dt className="text-muted-foreground">{m.profile_auth_level()}</dt>
            <dd>{String(me.data.session.authLevel)}</dd>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{m.profile_memberships()}</CardTitle>
          <CardDescription>{m.profile_memberships_subtitle()}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.profile_col_workspace()}</TableHead>
                <TableHead>{m.profile_col_kind()}</TableHead>
                <TableHead>{m.profile_col_role()}</TableHead>
                <TableHead>{m.profile_col_status()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {me.data.workspaces.map((w) => (
                <TableRow key={w.membershipId}>
                  <TableCell>
                    {here && w.workspaceId === here.id
                      ? (config.workspace?.name ?? here.name)
                      : w.workspaceId.slice(0, 8)}
                  </TableCell>
                  <TableCell>{w.kind === "staff" ? m.kind_staff() : m.kind_external()}</TableCell>
                  <TableCell>{w.role}</TableCell>
                  <TableCell>
                    <Badge variant={w.status === "active" ? "success" : "secondary"}>
                      {w.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <LanguageCard />
      <TransparencyNotice />
      <MySignedDocuments />
    </div>
  );
}
