import Link from "next/link";
import { Card } from "@/components/ui/form";

export default function ForbiddenPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <Card
          title="Not available to you"
          footer={
            <Link href="/" className="underline">
              Go to your home page
            </Link>
          }
        >
          <p className="text-sm text-muted">Your roles don&apos;t include this page. If you think they should, ask the Admin.</p>
        </Card>
      </div>
    </main>
  );
}
