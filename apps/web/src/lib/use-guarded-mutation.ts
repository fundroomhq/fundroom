import { type UseMutationOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  authRedirectFor,
  isLegalAcceptanceRequired,
  isSsoRequired,
  SSO_SESSION_RESTRICTED_KEY,
  sessionRestrictionOf,
} from "./api.js";

/**
 * `useMutation` that routes `unauthenticated` → login, `step_up_required` → step-up (with
 * `returnTo` = the current location), and `legal_acceptance_required` / `sso_required` → a
 * bootstrap refresh (which raises the acceptance interstitial or the "requires single sign-on"
 * screen) before the caller's `onError`.
 */
export function useGuardedMutation<TData, TVariables = void>(
  options: UseMutationOptions<TData, unknown, TVariables>,
) {
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  const queryClient = useQueryClient();
  return useMutation<TData, unknown, TVariables>({
    ...options,
    onError: (error, variables, context, mutation) => {
      // A bound session (workspace SSO, or central auth's handoff) may not change account
      // security: remember it (the security screen stands down) and let the caller show the
      // sentence as it shows any error.
      const restriction = sessionRestrictionOf(error);
      if (restriction !== undefined) {
        queryClient.setQueryData(SSO_SESSION_RESTRICTED_KEY, restriction);
      }
      if (isLegalAcceptanceRequired(error) || isSsoRequired(error)) {
        void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
        return;
      }
      const redirect = authRedirectFor(error, href);
      if (redirect !== undefined) {
        void navigate(redirect);
        return;
      }
      return options.onError?.(error, variables, context, mutation);
    },
  });
}
