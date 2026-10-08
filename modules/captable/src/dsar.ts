import { DSAR_TABLE_ROW_LIMIT, type ModuleDsar } from "@fundroom/module-kit";
import { decimalText } from "./model.js";
import { CaptableRepo } from "./repos/captable-repo.js";
import { fixed } from "./views.js";

/*
 * The cap-table part of a subject-access export (`modules/captable.json`): the member's own
 * holding lines in every snapshot — drafts, published and superseded — with the class, the
 * snapshot date and status. "Own" is the erasure handler's set: lines linked to the membership,
 * plus unlinked lines carrying any of the member's email addresses. Other holders' lines and the company-wide
 * totals are not the subject's data and are left out. Runs on the kernel's transaction only.
 */
export const captableDsar: ModuleDsar = {
  async export({ tx, ctx, membershipId }) {
    const repo = new CaptableRepo(ctx, tx);
    const rows = await repo.subjectHoldings(
      membershipId,
      await repo.memberEmails(membershipId),
      DSAR_TABLE_ROW_LIMIT,
    );
    return {
      version: 1,
      heldAboutMember: rows.length > 0,
      holdings: rows.map((r) => ({
        snapshotId: r.snapshotId,
        asOf: r.asOf,
        snapshotStatus: r.snapshotStatus,
        className: r.className,
        kind: r.kind,
        holderName: r.holderName,
        holderEmail: r.holderEmail,
        linked: r.membershipId === membershipId,
        shares: r.shares === null ? null : decimalText(fixed(r.shares) ?? 0n),
        amount: r.amount === null ? null : decimalText(fixed(r.amount) ?? 0n),
        currency: r.currency,
        issuedOn: r.issuedOn,
        erased: r.erasedAt !== null,
      })),
    };
  },
};
