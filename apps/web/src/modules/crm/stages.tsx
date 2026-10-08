import { Button, Input, LoadingState, PageHeader, toast } from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { ErrorAlert } from "../../components/error-alert.js";
import {
  callAs,
  crmApi,
  crmPipelineQuery,
  crmStagesQuery,
  type PipelineStage,
} from "../../lib/crm-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";

/*
 * The stage editor (§D10). Stages have stable **keys** and renameable names: the ten defaults
 * are seeded lazily on first read, a tenant may rename and reorder them and add custom ones,
 * and `wired` and `passed` are terminal.
 *
 * Two things are refused rather than allowed and then apologised for:
 *
 *  - a stage that has cards in it cannot be removed. The button is disabled with the count
 *    spelled out next to it, so the reason is on the screen before the click rather than in a
 *    409 afterwards — and the 409 is still surfaced, because another tab may have moved a card
 *    into it since this page loaded;
 *  - the two seeded terminal stages cannot be removed at all. They are what the round module's
 *    events move cards into, and a workspace without them would silently drop those moves.
 *
 * The whole list is saved in one `PUT`: positions are a property of the list, not of a row, and
 * saving them one at a time would leave the board in an order nobody chose.
 */

const LOCKED_KEYS: readonly string[] = ["wired", "passed"];

interface StageDraft {
  id: string | undefined;
  key: string;
  name: string;
  isTerminal: boolean;
}

function draftOf(stages: readonly PipelineStage[]): StageDraft[] {
  return [...stages]
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((s) => ({ id: s.id, key: s.key, name: s.name, isTerminal: s.isTerminal }));
}

/** `Soft committed` → `custom_soft_committed`; a custom key never collides with a seeded one. */
export function customKeyFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `custom_${slug === "" ? "stage" : slug}`;
}

function move<T>(rows: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  const [row] = next.splice(from, 1);
  if (row === undefined) return next;
  next.splice(to, 0, row);
  return next;
}

export function StagesScreen({ canManage }: { canManage: boolean }) {
  const base = useId();
  const stages = useQuery(crmStagesQuery);
  const pipeline = useQuery(crmPipelineQuery());
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<StageDraft[] | undefined>(undefined);

  const server = stages.data?.stages ?? [];
  const rows = draft ?? draftOf(server);
  const dirty = draft !== undefined;

  const countFor = (id: string | undefined): number =>
    id === undefined ? 0 : (pipeline.data?.items ?? []).filter((i) => i.stageId === id).length;

  const save = useGuardedMutation({
    mutationFn: () =>
      callAs<{ stages: readonly PipelineStage[] }>(
        crmApi().PUT("/crm/stages", {
          body: {
            stages: rows.map((row, index) => ({
              ...(row.id === undefined ? {} : { id: row.id }),
              key: row.key === "" ? customKeyFor(row.name) : row.key,
              name: row.name.trim(),
              position: index,
              isTerminal: row.isTerminal,
            })),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.crm_stages_saved());
      setDraft(undefined);
      void queryClient.invalidateQueries({ queryKey: ["crm"] });
    },
  });

  const update = (index: number, patch: Partial<StageDraft>) => {
    setDraft(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.crm_stages_title()}
        description={m.crm_stages_subtitle()}
        actions={
          canManage ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft([...rows, { id: undefined, key: "", name: "", isTerminal: false }])
              }
            >
              <Plus aria-hidden="true" />
              {m.crm_stage_add()}
            </Button>
          ) : null
        }
      />
      {stages.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {stages.isError ? <ErrorAlert error={stages.error} /> : null}
      <ErrorAlert error={save.error} />
      {stages.data ? (
        <>
          <ol className="space-y-3">
            {rows.map((row, index) => {
              const id = `${base}-${index}`;
              const count = countFor(row.id);
              const locked = LOCKED_KEYS.includes(row.key);
              const removable = !locked && count === 0;
              const label = row.name.trim() === "" ? m.crm_stage_new() : row.name;
              return (
                <li key={row.id ?? `new-${index}`} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-48 flex-1 space-y-1">
                      <label htmlFor={`${id}-name`} className="text-sm font-medium">
                        {m.crm_stage_name_label({ position: String(index + 1) })}
                      </label>
                      <Input
                        id={`${id}-name`}
                        required
                        maxLength={80}
                        readOnly={!canManage}
                        value={row.name}
                        onChange={(e) => update(index, { name: e.target.value })}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={row.isTerminal}
                        disabled={!canManage || locked}
                        onChange={(e) => update(index, { isTerminal: e.target.checked })}
                      />
                      {m.crm_stage_terminal_label({ name: label })}
                    </label>
                    {canManage ? (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={m.crm_stage_move_up({ name: label })}
                          disabled={index === 0}
                          onClick={() => setDraft(move(rows, index, index - 1))}
                        >
                          <ArrowUp aria-hidden="true" className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={m.crm_stage_move_down({ name: label })}
                          disabled={index === rows.length - 1}
                          onClick={() => setDraft(move(rows, index, index + 1))}
                        >
                          <ArrowDown aria-hidden="true" className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={m.crm_stage_remove({ name: label })}
                          disabled={!removable}
                          onClick={() => setDraft(rows.filter((_, i) => i !== index))}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {locked
                      ? m.crm_stage_locked({ name: label })
                      : count > 0
                        ? m.crm_stage_in_use({ count: String(count) })
                        : m.crm_stage_key({
                            key: row.key === "" ? m.crm_stage_key_new() : row.key,
                          })}
                  </p>
                </li>
              );
            })}
          </ol>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                loading={save.isPending}
                disabled={!dirty || rows.some((r) => r.name.trim() === "")}
                onClick={() => save.mutate()}
              >
                {m.crm_stages_save()}
              </Button>
              <p className="text-sm text-muted-foreground" role="status">
                {dirty ? m.crm_stages_unsaved() : m.crm_stages_no_changes()}
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
