import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";
import { ThemeToggle } from "./theme-toggle.js";
import { Toaster, toast } from "./toaster.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.js";

const meta = { title: "Components/Overlays" } satisfies Meta;
export default meta;
type Story = StoryObj;

export const DialogExample: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive">Revoke access</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke access for Jane?</DialogTitle>
          <DialogDescription>
            Every session ends now and pending invites she created are cancelled.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="destructive">Revoke</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

export const Menu: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Device actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>MacBook · Safari</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuItem>Sign out</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Forget device</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

export const TabsExample: Story = {
  render: () => (
    <Tabs defaultValue="sessions" className="w-96">
      <TabsList aria-label="Security settings">
        <TabsTrigger value="sessions">Sessions</TabsTrigger>
        <TabsTrigger value="devices">Devices</TabsTrigger>
        <TabsTrigger value="passkeys">Passkeys</TabsTrigger>
      </TabsList>
      <TabsContent value="sessions">Where you are signed in.</TabsContent>
      <TabsContent value="devices">Devices you have trusted.</TabsContent>
      <TabsContent value="passkeys">Passkeys registered to your account.</TabsContent>
    </Tabs>
  ),
};

export const TooltipExample: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Hover or focus me</Button>
      </TooltipTrigger>
      <TooltipContent>Only visible to invited investors</TooltipContent>
    </Tooltip>
  ),
};

export const Toasts: Story = {
  render: () => (
    <div className="flex gap-2">
      <Toaster />
      <Button onClick={() => toast.success("Invite sent")}>Success</Button>
      <Button
        variant="outline"
        onClick={() => toast.error("Could not send", { description: "Request id req_123" })}
      >
        Error
      </Button>
    </div>
  ),
};

export const ThemeToggleExample: Story = {
  render: () => (
    <ThemeToggle
      labels={{ light: "Light", dark: "Dark", system: "System", toggle: "Change theme" }}
    />
  ),
};
