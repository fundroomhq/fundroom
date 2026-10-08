import type { Meta, StoryObj } from "@storybook/react-vite";
import { FolderOpenIcon } from "lucide-react";
import { Button } from "../components/button.js";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../components/states.js";

const meta = { title: "Foundations/States" } satisfies Meta;
export default meta;
type Story = StoryObj;

export const Empty: Story = {
  render: () => (
    <EmptyState
      className="w-[28rem]"
      icon={<FolderOpenIcon />}
      title="No documents yet"
      description="Upload a deck or pick a folder template to get started."
      action={<Button>Upload</Button>}
    />
  ),
};
export const ErrorExample: Story = {
  render: () => (
    <ErrorState
      className="w-[28rem]"
      title="Could not load the data room"
      description="Try again; quote the request id if you contact support."
      requestId="req_01J8ZK"
      onRetry={() => {}}
    />
  ),
};
export const Loading: Story = { render: () => <LoadingState className="w-[28rem]" lines={4} /> };
export const Header: Story = {
  render: () => (
    <PageHeader
      className="w-[36rem]"
      title="People"
      description="Who can get in, and why."
      actions={<Button>Invite</Button>}
    />
  ),
};
