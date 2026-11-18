import Link from "next/link";
import { StatusScreen, primaryLinkClass } from "@/components/status-screen";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <StatusScreen
      code="404"
      title="We can't find that page"
      actions={
        <Link href="/" className={primaryLinkClass}>
          Go to your home page
        </Link>
      }
    >
      <p>The link may be old or mistyped. Links in our SMS and emails work only once and for a limited time; ask MOAUM for a new one if yours has expired.</p>
    </StatusScreen>
  );
}
