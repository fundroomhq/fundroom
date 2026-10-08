import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
} from "@fundroomhq/ui";
import { type ReactNode, useId, useState } from "react";
import { m } from "../paraglide/messages.js";

/*
 * `ConfirmDialog` (components/access/common.tsx) with a typed phrase (E2.7 danger zones). The
 * irreversible actions — transfer ownership, revoke every session, delete the workspace — ask
 * for the workspace slug typed back, the same check the server makes (`confirm` must equal the
 * slug, else `validation_failed` / `confirmation_mismatch`), so a stray click on the wrong
 * card cannot do any of them.
 *
 *  - The confirm button stays disabled until the input equals `phrase` exactly: no trimming,
 *    no case folding. What the server compares is what the button waits for.
 *  - The input is labelled "Type {phrase} to confirm", so a screen reader reads the phrase as
 *    part of the field's name rather than from somewhere nearby.
 *  - The typed text is cleared whenever the dialog closes: reopening it must ask again.
 *  - It is a form, so Enter submits once the phrase matches.
 */
export function TypedConfirmDialog({
  trigger,
  title,
  description,
  phrase,
  confirmLabel,
  onConfirm,
  pending,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  phrase: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const matches = phrase !== "" && typed === phrase;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!matches || pending) return;
            onConfirm();
            setOpen(false);
            setTyped("");
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          <div className="grid gap-2">
            <Label htmlFor={inputId}>{m.typed_confirm_label({ phrase })}</Label>
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={!matches} loading={pending}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
