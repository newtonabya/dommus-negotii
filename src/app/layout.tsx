import type { Metadata } from "next";
import "@fontsource-variable/montserrat";
import { isStaging } from "@/lib/stage";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Dommus Negotii", template: "%s · Dommus Negotii" },
  description: "MOAUM Credit Super Store: loans, repayments and statements for members.",
  icons: { icon: "/brand/logo.png", apple: "/brand/logo.png" },
};

export const viewport = { themeColor: "#231f20" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-NG" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        {isStaging() ? (
          <div className="bg-foreground px-4 py-1 text-center text-xs font-semibold text-background">
            STAGING — test data only. SMS and emails are not sent; they are written to the server log.
          </div>
        ) : null}
        {children}
      </body>
    </html>
  );
}
