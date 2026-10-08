import { createFileRoute } from "@tanstack/react-router";
import { DelegatesCard } from "../../../components/access/delegates.js";

/*
 * An investor's own delegates (E3.2): people who act for them with all, or part, of what they can
 * see. The workspace decides whether investors may add them (`access.allowDelegates`) and how many;
 * the card shows the server's answer either way, so a principal can always see and remove theirs.
 */
export const Route = createFileRoute("/_portal/settings/delegates")({ component: Delegates });

function Delegates() {
  return (
    <div className="max-w-3xl">
      <DelegatesCard mode="self" />
    </div>
  );
}
