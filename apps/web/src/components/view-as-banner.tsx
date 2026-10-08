import { Button, toast } from "@fundroomhq/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye } from "lucide-react";
import { callNoContent } from "../lib/access-admin-queries.js";
import { api, describeError } from "../lib/api.js";
import { resetForViewAs, type ViewAsState } from "../lib/queries.js";
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(getLocale(), { timeStyle: "short" }).format(d);
}

/**
 * The strip `AppShell` pins above the header while a staff member views the portal as an
 * investor (E2.7). It says whose portal this is, that it is read-only and when it ends, and
 * offers the way out: `DELETE /me/view-as`, then every cached answer (all of them the
 * investor's) is dropped and the staff member lands back on that person's admin page.
 */
export function ViewAsBanner({ viewAs }: { viewAs: ViewAsState }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const exit = useMutation({
    mutationFn: () => callNoContent(api().DELETE("/me/view-as")),
    onSuccess: async () => {
      await resetForViewAs(queryClient);
      await navigate({
        to: "/admin/people/$membershipId",
        params: { membershipId: viewAs.membershipId },
      });
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const name = viewAs.name ?? m.view_as_unnamed();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Eye aria-hidden="true" className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">{m.view_as_banner({ name, time: formatTime(viewAs.until) })}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="border-current bg-transparent text-current hover:bg-background/20 hover:text-current"
        loading={exit.isPending}
        onClick={() => exit.mutate()}
      >
        {m.view_as_exit()}
      </Button>
    </div>
  );
}
