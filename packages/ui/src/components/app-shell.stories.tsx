import type { Meta, StoryObj } from "@storybook/react-vite";
import { FolderIcon, HomeIcon, MailIcon } from "lucide-react";
import { AppShell, AppShellSidebar, NavList } from "./app-shell.js";
import { PageHeader } from "./states.js";
import { ThemeToggle } from "./theme-toggle.js";

const meta = {
  title: "Layout/AppShell",
  component: AppShell,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

const items = [
  { id: "home", label: "Home", to: "/", icon: <HomeIcon />, active: true },
  { id: "data-room", label: "Data room", to: "/data-room", icon: <FolderIcon /> },
  { id: "updates", label: "Updates", to: "/updates", icon: <MailIcon /> },
];

export const Investor: Story = {
  args: {
    skipToContentLabel: "Skip to content",
    menuLabel: "Menu",
    sidebar: (
      <AppShellSidebar>
        <div className="px-2 text-lg font-semibold">Acme</div>
        <NavList
          ariaLabel="Primary"
          items={items}
          render={(item, props) => (
            <a href={item.to} {...props}>
              {item.icon}
              {item.label}
            </a>
          )}
        />
      </AppShellSidebar>
    ),
    header: (
      <div className="ml-auto">
        <ThemeToggle labels={{ light: "Light", dark: "Dark", system: "System", toggle: "Theme" }} />
      </div>
    ),
    children: <PageHeader title="Welcome back" description="What changed since your last visit." />,
  },
};

export const Embedded: Story = {
  args: { ...Investor.args, fullHeight: false, sidebar: undefined, header: undefined },
};

export const ViewingAs: Story = {
  args: {
    ...Investor.args,
    banner: "Viewing as Ada Lovelace — read-only. Downloads are off. Ends at 14:30.",
  },
};
