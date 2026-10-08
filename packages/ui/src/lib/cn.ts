import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's `cn`: clsx + tailwind-merge so callers can override component classes. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
