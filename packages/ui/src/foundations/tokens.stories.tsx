import type { Meta, StoryObj } from "@storybook/react-vite";
import { DEFAULT_TOKENS } from "../theme/tokens.js";

const meta = { title: "Foundations/Tokens", parameters: { layout: "padded" } } satisfies Meta;
export default meta;
type Story = StoryObj;

const colorNames = Object.keys(DEFAULT_TOKENS.light)
  .filter((k) => k.startsWith("--sh-color-"))
  .map((k) => k.replace("--sh-color-", ""));

export const Palette: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      {colorNames.map((name) => (
        <div key={name} className="flex flex-col gap-1 text-xs">
          <div
            className="h-12 rounded-md border"
            style={{ background: `var(--sh-color-${name})` }}
          />
          <code>--sh-color-{name}</code>
        </div>
      ))}
    </div>
  ),
};

export const Typography: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <h1 className="text-3xl font-semibold tracking-tight">Heading 1 · text-3xl</h1>
      <h2 className="text-2xl font-semibold tracking-tight">Heading 2 · text-2xl</h2>
      <h3 className="text-xl font-semibold">Heading 3 · text-xl</h3>
      <p className="text-base">
        Body · text-base. Investors are infrequent readers; keep it plain.
      </p>
      <p className="text-sm text-muted-foreground">Muted · text-sm</p>
      <code className="font-mono text-sm">mono · req_01J8ZK</code>
    </div>
  ),
};

export const Shape: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      {(["sm", "md", "lg", "xl"] as const).map((r) => (
        <div
          key={r}
          className={`flex size-16 items-center justify-center border bg-card text-xs rounded-${r}`}
        >
          {r}
        </div>
      ))}
      <div className="size-16 rounded-lg bg-card shadow-sm" />
      <div className="size-16 rounded-lg bg-card shadow-md" />
    </div>
  ),
};
