import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertCircleIcon, CheckCircle2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./alert.js";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar.js";
import { Badge } from "./badge.js";
import { Button } from "./button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card.js";
import { Separator } from "./separator.js";
import { Skeleton } from "./skeleton.js";
import { Spinner } from "./spinner.js";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.js";

const meta = { title: "Components/Surfaces" } satisfies Meta;
export default meta;
type Story = StoryObj;

export const CardExample: Story = {
  render: () => (
    <Card className="w-96">
      <CardHeader>
        <CardTitle>Seed round</CardTitle>
        <CardDescription>Closing 30 September</CardDescription>
        <CardAction>
          <Badge variant="success">Open</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-sm">Data room, deck and terms are available to invited investors.</p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button>Open data room</Button>
        <Button variant="outline">Details</Button>
      </CardFooter>
    </Card>
  ),
};

export const Alerts: Story = {
  render: () => (
    <div className="grid w-[28rem] gap-3">
      <Alert>
        <CheckCircle2Icon />
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>The privacy notice was updated.</AlertDescription>
      </Alert>
      <Alert variant="success">
        <CheckCircle2Icon />
        <AlertTitle>Invite sent</AlertTitle>
      </Alert>
      <Alert variant="warning">
        <AlertCircleIcon />
        <AlertTitle>Unscanned</AlertTitle>
        <AlertDescription>
          No antivirus is configured; uploads are marked unscanned.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>Sign-in failed</AlertTitle>
        <AlertDescription>The code has expired. Request a new one.</AlertDescription>
      </Alert>
    </div>
  ),
};

export const Badges: Story = {
  render: () => (
    <div className="flex gap-2">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="success">Active</Badge>
      <Badge variant="warning">Pending</Badge>
      <Badge variant="destructive">Revoked</Badge>
    </div>
  ),
};

export const Misc: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Avatar>
        <AvatarImage src="" alt="" />
        <AvatarFallback>NA</AvatarFallback>
      </Avatar>
      <Separator orientation="vertical" className="h-8" />
      <Spinner label="Loading" />
      <Separator orientation="vertical" className="h-8" />
      <Skeleton className="h-8 w-32" />
    </div>
  ),
};

export const DataTable: Story = {
  render: () => (
    <Table>
      <TableCaption>Active sessions</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Device</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead>Level</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>MacBook · Safari</TableCell>
          <TableCell>2 minutes ago</TableCell>
          <TableCell>
            <Badge variant="secondary">Passkey</Badge>
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell>iPhone · Safari</TableCell>
          <TableCell>Yesterday</TableCell>
          <TableCell>
            <Badge variant="outline">Code</Badge>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
