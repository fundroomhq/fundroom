import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen } from "../test/render.js";
import { Button } from "./button.js";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "./states.js";

describe("states", () => {
  it("EmptyState renders title, description and action", async () => {
    const { container } = render(
      <EmptyState
        title="No documents"
        description="Upload one."
        action={<Button>Upload</Button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No documents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("ErrorState is an alert, shows the request id and retries", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container } = render(
      <ErrorState
        title="Failed"
        requestId="req_123"
        requestIdLabel="Request"
        onRetry={onRetry}
        retryLabel="Retry"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("req_123");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("LoadingState announces busy with an sr-only label", async () => {
    const { container } = render(<LoadingState label="Loading documents" lines={2} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading documents");
    await expectNoA11yViolations(container);
  });

  it("PageHeader renders an h1", () => {
    render(
      <PageHeader title="People" description="Who can get in" actions={<Button>Invite</Button>} />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "People" })).toBeInTheDocument();
  });
});
