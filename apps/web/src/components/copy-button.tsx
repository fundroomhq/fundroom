import { Button, toast } from "@fundroomhq/ui";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { m } from "../paraglide/messages.js";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error(m.common_copy_failed());
        }
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? m.common_copied() : label}
    </Button>
  );
}
