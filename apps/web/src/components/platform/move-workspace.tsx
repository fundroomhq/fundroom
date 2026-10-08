import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  fieldAria,
  Input,
  LoadingState,
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, CircleDot, TriangleAlert } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { formatDateTime } from "../../lib/format.js";
import {
  type Cell,
  cancelMove,
  describePlatformError,
  MOVES_KEY,
  type Move,
  moveErrorSentence,
  PLATFORM_KEY,
  type PlatformWorkspaceDetail,
  platformCellsQuery,
  platformMovesQuery,
  requestMove,
  workspaceKey,
} from "../../lib/platform-queries.js";
import {
  isMoveCancellable,
  isMoveOver,
  isMoveSwitched,
  MOVE_STEPS,
  moveStateLabel,
} from "../../lib/residency-queries.js";
import { m } from "../../paraglide/messages.js";
import { NativeSelect } from "../compliance/common.js";

/*
 * Moving a workspace to a cell in ANOTHER database (E3.11, ADR-0059). Heavy and deliberate: the
 * workspace goes on a `relocation` hold (planned downtime for its members), is exported, pulled
 * and imported by the target cell, and the directory switches over. A move is an import, so
 * whatever an import does not carry is lost — the card says so before the operator confirms,
 * and the confirmation is the workspace's slug typed out. Same-database cells are the plan/cell
 * card's instant label change instead.
 */
export function MoveWorkspaceCard({ ws }: { ws: PlatformWorkspaceDetail }) {
  const moves = useQuery(platformMovesQuery(ws.id));
  const cells = useQuery(platformCellsQuery);
  const latest = moves.data?.items[0];
  const live = latest !== undefined && !isMoveOver(latest.state);
  const cellList = cells.data?.cells ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.platform_move_title()}</CardTitle>
        <CardDescription>{m.platform_move_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {moves.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
        {moves.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{describePlatformError(moves.error)}</AlertDescription>
          </Alert>
        ) : null}
        {latest !== undefined && live ? (
          <MoveProgress ws={ws} move={latest} cells={cellList} />
        ) : null}
        {latest !== undefined && !live ? <LastMove move={latest} cells={cellList} /> : null}
        {moves.data && !live ? (
          <MoveForm ws={ws} cells={cellList} cellsPending={cells.isPending} />
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A cell as the card names it: its id and where it is. */
function cellName(cells: readonly Cell[], id: string, region: string | null): string {
  const cell = cells.find((c) => c.id === id);
  const where =
    cell !== undefined ? (cell.regionLabel.trim() === "" ? cell.region : cell.regionLabel) : region;
  return where === null || where === "" ? id : m.platform_cell_option({ id, region: where });
}

function useInvalidateMoves(ws: PlatformWorkspaceDetail) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: MOVES_KEY });
    void queryClient.invalidateQueries({ queryKey: workspaceKey(ws.id) });
    void queryClient.invalidateQueries({ queryKey: [...PLATFORM_KEY, "workspaces", "list"] });
  };
}

function MoveProgress({
  ws,
  move,
  cells,
}: {
  ws: PlatformWorkspaceDetail;
  move: Move;
  cells: readonly Cell[];
}) {
  const current = MOVE_STEPS.indexOf(move.state as (typeof MOVE_STEPS)[number]);
  const target = cellName(cells, move.targetCellId, move.targetRegion);
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {isMoveSwitched(move.state)
          ? m.platform_move_switched_body({ target })
          : m.platform_move_live_body({ target, when: formatDateTime(move.createdAt) })}
      </p>
      {/* Announced as it changes: the card polls while the move runs. */}
      <p role="status" className="text-sm font-medium">
        {m.platform_move_state({ state: moveStateLabel(move.state) })}
      </p>
      <ol aria-label={m.platform_move_progress()} className="grid gap-2 text-sm sm:grid-cols-3">
        {MOVE_STEPS.map((step, i) => {
          const done = i < current;
          const now = i === current;
          const Icon = done ? Check : now ? CircleDot : Circle;
          return (
            <li
              key={step}
              aria-current={now ? "step" : undefined}
              className={
                now
                  ? "flex items-center gap-2 font-medium"
                  : done
                    ? "flex items-center gap-2"
                    : "flex items-center gap-2 text-muted-foreground"
              }
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span>{moveStateLabel(step)}</span>
              {done ? <span className="sr-only">{m.platform_move_step_done()}</span> : null}
            </li>
          );
        })}
      </ol>
      {isMoveCancellable(move.state) ? <CancelMove ws={ws} move={move} target={target} /> : null}
    </div>
  );
}

function CancelMove({
  ws,
  move,
  target,
}: {
  ws: PlatformWorkspaceDetail;
  move: Move;
  target: string;
}) {
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidateMoves(ws);
  const cancel = useMutation({
    mutationFn: () => cancelMove(move.id),
    onSuccess: () => {
      invalidate();
      setOpen(false);
      toast.success(m.platform_move_cancelled_toast({ name: ws.name }));
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) cancel.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          {m.platform_move_cancel()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.platform_move_cancel_title({ name: ws.name })}</DialogTitle>
          <DialogDescription>{m.platform_move_cancel_body({ target })}</DialogDescription>
        </DialogHeader>
        {cancel.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{describePlatformError(cancel.error)}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {m.platform_move_keep()}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {m.platform_move_cancel()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The outcome of the last move that is over (failed, cancelled or completed). */
function LastMove({ move, cells }: { move: Move; cells: readonly Cell[] }) {
  const target = cellName(cells, move.targetCellId, move.targetRegion);
  const when = formatDateTime(move.updatedAt);
  if (move.state === "failed") {
    return (
      <Alert variant="destructive" role="note">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{m.platform_move_failed_title({ target })}</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            {move.error === null ? m.platform_move_error_unknown() : moveErrorSentence(move.error)}
          </p>
          <p>{m.platform_move_failed_rollback({ when })}</p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {move.state === "cancelled"
        ? m.platform_move_last_cancelled({ target, when })
        : m.platform_move_last_done({ target, when })}
    </p>
  );
}

function MoveForm({
  ws,
  cells,
  cellsPending,
}: {
  ws: PlatformWorkspaceDetail;
  cells: readonly Cell[];
  cellsPending: boolean;
}) {
  const targetId = useId();
  const confirmId = useId();
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState("");
  const invalidate = useInvalidateMoves(ws);
  const move = useMutation({
    mutationFn: () => requestMove(ws.id, { targetCellId: target, confirmSlug: confirm }),
    onSuccess: () => {
      invalidate();
      setTarget("");
      setConfirm("");
      toast.success(m.platform_move_requested_toast({ name: ws.name }));
    },
  });
  // Cells served by another database, open for new workspaces. The server checks the rest
  // (a fresh heartbeat, the directory being shared) and says why when it refuses.
  const remote = cells.filter((c) => !c.local && c.status === "active");
  if (ws.deletedAt !== null) {
    return <p className="text-sm text-muted-foreground">{m.platform_move_deleted()}</p>;
  }
  if (cellsPending) return null;
  if (remote.length === 0) {
    return <p className="text-sm text-muted-foreground">{m.platform_move_no_targets()}</p>;
  }
  const matches = confirm === ws.slug;
  const ready = target !== "" && matches;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !move.isPending) move.mutate();
  };
  return (
    <form className="space-y-4" aria-label={m.platform_move_title()} onSubmit={submit} noValidate>
      <Field id={targetId} label={m.platform_move_target()} required>
        <NativeSelect
          id={targetId}
          value={target}
          required
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">{m.platform_move_target_choose()}</option>
          {remote.map((c) => (
            <option key={c.id} value={c.id}>
              {cellName(cells, c.id, c.region)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Alert variant="warning" role="note">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{m.platform_move_loss_title()}</AlertTitle>
        <AlertDescription>
          <p>{m.platform_move_loss_body()}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>{m.platform_move_loss_sign_in()}</li>
            <li>{m.platform_move_loss_credentials()}</li>
            <li>{m.platform_move_loss_integrations()}</li>
            <li>{m.platform_move_loss_domains()}</li>
            <li>{m.platform_move_loss_audit()}</li>
            <li>{m.platform_move_loss_downtime()}</li>
          </ul>
        </AlertDescription>
      </Alert>
      <Field
        id={confirmId}
        label={m.platform_move_confirm_label({ slug: ws.slug })}
        description={m.platform_move_confirm_help()}
        required
      >
        <Input
          id={confirmId}
          value={confirm}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          onChange={(e) => setConfirm(e.target.value)}
          {...fieldAria(confirmId, { description: true })}
        />
      </Field>
      {move.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{describePlatformError(move.error)}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" variant="destructive" loading={move.isPending} disabled={!ready}>
        {m.platform_move_submit()}
      </Button>
    </form>
  );
}
