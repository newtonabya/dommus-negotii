export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-sm font-semibold tracking-wide text-muted uppercase">Dommus Negotii</p>
        {children}
      </div>
    </main>
  );
}
