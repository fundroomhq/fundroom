import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { formatDateTime } from "../../lib/format.js";
import {
  bookingProviderLabel,
  bookingStatusLabel,
  type IntegrationBooking,
  integrationBookingsQuery,
} from "../../lib/integrations-queries.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * The meetings the booking webhooks recorded (E3.6), newest first. Read-only: the vendor owns
 * the booking; we keep what it told us (400 days after the meeting) and whether the invitee's
 * address matched a member at the time. CRM shows the same rows as contact activity.
 */
export function BookingsCard() {
  const bookings = useInfiniteQuery(integrationBookingsQuery());
  const items = bookings.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.booking_register_title()}</h2>
        </CardTitle>
        <CardDescription>{m.booking_register_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {bookings.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
        {bookings.isError ? <ErrorAlert error={bookings.error} /> : null}
        {bookings.data && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.booking_register_empty()}</p>
        ) : null}
        {items.length === 0 ? null : (
          <div className="overflow-x-auto">
            <Table aria-label={m.booking_register_title()}>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.booking_col_when()}</TableHead>
                  <TableHead>{m.booking_col_invitee()}</TableHead>
                  <TableHead>{m.booking_col_event()}</TableHead>
                  <TableHead>{m.booking_col_provider()}</TableHead>
                  <TableHead>{m.booking_col_status()}</TableHead>
                  <TableHead>{m.booking_col_member()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((b) => (
                  <BookingRow key={b.id} booking={b} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {bookings.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            loading={bookings.isFetchingNextPage}
            onClick={() => void bookings.fetchNextPage()}
          >
            {m.booking_register_more()}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BookingRow({ booking }: { booking: IntegrationBooking }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">{formatDateTime(booking.startsAt)}</TableCell>
      <TableCell>
        <span className="block">{booking.inviteeName ?? booking.inviteeEmail}</span>
        {booking.inviteeName === null ? null : (
          <span className="block text-xs text-muted-foreground">{booking.inviteeEmail}</span>
        )}
      </TableCell>
      <TableCell>{booking.eventName ?? m.booking_event_unnamed()}</TableCell>
      <TableCell>{bookingProviderLabel(booking.provider)}</TableCell>
      <TableCell>
        <Badge
          variant={
            booking.status === "cancelled"
              ? "secondary"
              : booking.status === "rescheduled"
                ? "outline"
                : "success"
          }
        >
          {bookingStatusLabel(booking.status)}
        </Badge>
      </TableCell>
      <TableCell>
        {booking.membershipId === null ? m.booking_member_no() : m.booking_member_yes()}
      </TableCell>
    </TableRow>
  );
}
