import Link from "next/link";
import { StatusScreen, primaryLinkClass } from "@/components/status-screen";

export const metadata = { title: "Not available to you" };

export default function ForbiddenPage() {
  return (
    <StatusScreen
      code="403"
      title="Not available to you"
      actions={
        <Link href="/" className={primaryLinkClass}>
          Go to your home page
        </Link>
      }
    >
      <p>Your roles don&apos;t include this page. If you think they should, ask the Admin.</p>
    </StatusScreen>
  );
}
