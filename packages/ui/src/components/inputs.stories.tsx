import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./checkbox.js";
import { Field, fieldAria } from "./field.js";
import { Input } from "./input.js";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "./input-otp.js";
import { Label } from "./label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js";
import { Switch } from "./switch.js";
import { Textarea } from "./textarea.js";

const meta = { title: "Components/Inputs" } satisfies Meta;
export default meta;
type Story = StoryObj;

export const TextField: Story = {
  render: () => (
    <div className="grid w-80 gap-6">
      <Field id="email" label="Email" description="We only use it to sign you in." required>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          {...fieldAria("email", { description: true })}
        />
      </Field>
      <Field id="name" label="Display name" error="Pick something shorter than 80 characters.">
        <Input
          id="name"
          defaultValue="A very long display name"
          {...fieldAria("name", { error: true })}
        />
      </Field>
      <Field id="notes" label="Notes">
        <Textarea id="notes" placeholder="Optional" />
      </Field>
    </div>
  ),
};

export const OneTimeCode: Story = {
  render: () => (
    <InputOTP maxLength={6} aria-label="Sign-in code">
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>
  ),
};

export const Toggles: Story = {
  render: () => (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <Checkbox id="remember" defaultChecked />
        <Label htmlFor="remember">Trust this device for 30 days</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="alerts" />
        <Label htmlFor="alerts">Email me when someone views a document</Label>
      </div>
    </div>
  ),
};

export const SelectMenu: Story = {
  render: () => (
    <div className="grid w-64 gap-2">
      <Label htmlFor="role">Role</Label>
      <Select defaultValue="investor">
        <SelectTrigger id="role" className="w-full">
          <SelectValue placeholder="Pick a role" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="investor">Investor</SelectItem>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="owner">Owner</SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};
