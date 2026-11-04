import { Logo } from "@/components/brand";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo size={132} priority />
          <p className="text-lg font-extrabold tracking-wide uppercase">MOAUM Credit Super Store</p>
          <div className="brand-rule w-40" aria-hidden="true" />
        </div>
        {children}
        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs font-semibold text-muted">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Secure, encrypted connection · MOAUM never asks for your password or codes by phone
        </p>
      </div>
    </main>
  );
}
