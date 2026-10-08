import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut, Settings } from "lucide-react";
import { api, call } from "../lib/api.js";
import { initials } from "../lib/format.js";
import { type Me, meQuery } from "../lib/queries.js";
import { m } from "../paraglide/messages.js";

export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    try {
      await call(api().POST("/auth/logout"));
    } catch {
      // The cookie may already be gone; the login screen is the right place either way.
    }
    // Drop every cached response of the signed-in user, not just mark it stale (F-25, ASVS
    // 14.3.1): stale data is still rendered, and would be to whoever signs in next.
    queryClient.clear();
    queryClient.setQueryData(meQuery.queryKey, null);
    await navigate({ to: "/login", search: { returnTo: "/" } });
  };
}

export function AccountMenu({ me }: { me: Me }) {
  const signOut = useSignOut();
  const name = me.session.user.displayName;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={m.account_menu_label()}>
          <Avatar>
            <AvatarFallback>{initials(name)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings aria-hidden="true" />
            {m.nav_settings()}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut aria-hidden="true" />
          {m.account_sign_out()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
