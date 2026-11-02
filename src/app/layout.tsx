import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Dommus Negotii", template: "%s · Dommus Negotii" },
  description: "MOAUM group services portal",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-NG" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
