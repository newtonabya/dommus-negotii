import type { Metadata } from "next";
import { isStaging } from "@/lib/stage";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Dommus Negotii", template: "%s · Dommus Negotii" },
  description: "MOAUM group services portal",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-NG" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        {isStaging() ? (
          <div className="bg-accent px-4 py-1 text-center text-xs font-medium text-accent-foreground">
            STAGING — test data only. SMS and emails are not sent; they are written to the server log.
          </div>
        ) : null}
        {children}
      </body>
    </html>
  );
}
