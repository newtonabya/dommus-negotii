import Image from "next/image";

/**
 * The FAUM Consultancy logo, never altered (proportionally scaled copy in
 * public/brand). `size` is the rendered height in pixels; width follows.
 */
export function Logo({ size, priority = false }: { size: number; priority?: boolean }) {
  return (
    <Image
      src="/brand/logo.png"
      alt="FAUM Consultancy Services Limited logo"
      width={495}
      height={700}
      priority={priority}
      style={{ height: size, width: "auto" }}
    />
  );
}

/** Logo with the app name, for page headers. */
export function BrandMark({ subtitle }: { subtitle?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <Logo size={44} priority />
      <span className="min-w-0 leading-tight">
        <span className="block text-[13px] font-extrabold tracking-wide uppercase sm:text-sm">
          MOAUM <span className="hidden min-[400px]:inline">Credit </span>Super Store
        </span>
        {subtitle ? <span className="block truncate text-xs font-semibold text-muted">{subtitle}</span> : null}
      </span>
    </span>
  );
}
