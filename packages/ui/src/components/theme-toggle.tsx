import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { Theme } from "../theme/theme-provider.js";
import { useTheme } from "../theme/theme-provider.js";
import { Button } from "./button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";

export interface ThemeToggleProps {
  labels: { light: string; dark: string; system: string; toggle: string };
  className?: string;
}

const ICONS = { light: SunIcon, dark: MoonIcon, system: MonitorIcon } as const;

export function ThemeToggle({ labels, className }: ThemeToggleProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const Current = resolvedTheme === "dark" ? MoonIcon : SunIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={labels.toggle} className={className}>
          <Current aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(["light", "dark", "system"] as const satisfies readonly Theme[]).map((t) => {
          const Icon = ICONS[t];
          return (
            <DropdownMenuItem
              key={t}
              onSelect={() => setTheme(t)}
              aria-checked={theme === t}
              role="menuitemradio"
            >
              <Icon aria-hidden="true" />
              {labels[t]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
