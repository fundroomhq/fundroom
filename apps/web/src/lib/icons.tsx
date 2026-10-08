import {
  Activity,
  Archive,
  BarChart3,
  Bell,
  Building2,
  Circle,
  ClipboardCheck,
  CreditCard,
  FileText,
  FolderLock,
  Frame,
  Globe,
  Home,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogIn,
  type LucideIcon,
  Mail,
  Megaphone,
  Palette,
  PieChart,
  Plug,
  Scale,
  Settings,
  Shield,
  Signature,
  Sparkles,
  UserPlus,
  Users,
  Webhook,
} from "lucide-react";

/** Icon names a module may put on a nav item; unknown names fall back to a dot. */
const ICONS: Record<string, LucideIcon> = {
  home: Home,
  dashboard: LayoutDashboard,
  "data-room": FolderLock,
  folder: FolderLock,
  updates: Megaphone,
  mail: Mail,
  metrics: BarChart3,
  round: PieChart,
  // E2.5: the `crm` manifest's nav slot asks for this name (contract §D11), and an unknown
  // name falls back to a dot in silence — the trap E2.1 recorded for `domain`.
  crm: Users,
  people: Users,
  users: Users,
  access: KeyRound,
  audit: Shield,
  shield: Shield,
  branding: Palette,
  // E2.1: the `domains` manifest's nav slot asks for this name, and an unknown name falls
  // back to a dot in silence — so the nav item would lose its icon with no error anywhere.
  domain: Globe,
  // E2.2: the `embed` manifest asks for this name, and an unknown one falls back to a dot
  // in silence — the same trap E2.1 recorded for `domain`.
  embed: Frame,
  settings: Settings,
  company: Building2,
  document: FileText,
  notifications: Bell,
  // E2.7: the access review, jobs and health nav items ask for these names (an unknown name
  // falls back to a dot in silence — the trap E2.1 recorded for `domain`).
  review: ClipboardCheck,
  jobs: Layers,
  health: Activity,
  // The `compliance` manifest has asked for `legal` since E1.6 and got the fallback dot.
  legal: Scale,
  // E2.8: the `portability` manifest's admin.settings slot (workspace export) asks for this.
  export: Archive,
  // E3.1: the access-request approval queue (`access` manifest).
  requests: UserPlus,
  // E3.4: the `api-keys` and `webhooks` manifests' admin.settings entries.
  key: KeyRound,
  webhook: Webhook,
  // E3.5: the `esign` manifest's admin.settings entry.
  signature: Signature,
  // E3.6: the `integrations` manifest's admin.settings entry and the `captable` module's nav.
  plug: Plug,
  "pie-chart": PieChart,
  // E3.8: the `sso` manifest's admin.settings entry.
  sso: LogIn,
  // E3.10: the `billing` kernel manifest's admin.settings entry.
  billing: CreditCard,
  // E3.11: the `residency` kernel manifest's admin.settings entry.
  residency: Globe,
  // E3.12: the `ai` kernel manifest's admin.settings entry (AI assist).
  sparkles: Sparkles,
};

export function iconFor(name: string | undefined): LucideIcon {
  return (name !== undefined ? ICONS[name] : undefined) ?? Circle;
}
