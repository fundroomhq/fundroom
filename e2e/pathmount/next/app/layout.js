// next.test — the customer's site (harness only, not part of the recipe).
export const metadata = { title: "Acme (Next.js)" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
