import { Checkbox, Label } from "@fundroomhq/ui";
import type { ReactNode } from "react";

/**
 * A checkbox per group (the invite dialog's group picker, shared with the access-request
 * approve dialog and the "default groups" access setting). Controlled: `value` is the selected
 * ids, `onChange` receives the next selection. `idPrefix` keeps the checkbox ids unique when
 * two pickers share a page.
 */
export function GroupPicker({
  groups,
  value,
  onChange,
  legend,
  description,
  idPrefix,
  disabled,
}: {
  groups: readonly { id: string; name: string }[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  legend: ReactNode;
  description?: ReactNode;
  idPrefix: string;
  disabled?: boolean;
}) {
  const descriptionId = `${idPrefix}-description`;
  return (
    <fieldset className="space-y-2" {...(description ? { "aria-describedby": descriptionId } : {})}>
      <legend className="text-sm font-medium">{legend}</legend>
      {description ? (
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {groups.map((g) => {
        const id = `${idPrefix}-${g.id}`;
        return (
          <div key={g.id} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={value.includes(g.id)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? [...value.filter((x) => x !== g.id), g.id]
                    : value.filter((x) => x !== g.id),
                )
              }
            />
            <Label htmlFor={id}>{g.name}</Label>
          </div>
        );
      })}
    </fieldset>
  );
}
