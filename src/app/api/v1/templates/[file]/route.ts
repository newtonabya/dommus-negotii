import { NextResponse } from "next/server";
import { buildCsvTemplate, buildXlsxTemplate } from "@/modules/credit/imports/table";
import { TEMPLATES, type TemplateName } from "@/modules/credit/imports/templates";
import { loadCurrentUser } from "@/shell/auth/session";

/** Downloadable import templates, e.g. /api/v1/templates/members.xlsx (staff only). */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/templates/[file]">) {
  const { file } = await ctx.params;
  const result = await loadCurrentUser();
  if ("problem" in result || !result.user.isStaff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });

  const match = /^(invitations|members)\.(xlsx|csv)$/.exec(file);
  if (!match) return new NextResponse(null, { status: 404 });
  const template = TEMPLATES[match[1] as TemplateName];
  const filename = `dommus-${match[1]}-template.${match[2]}`;

  if (match[2] === "csv") {
    return new NextResponse(buildCsvTemplate(template.columns), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` },
    });
  }
  const bytes = await buildXlsxTemplate(template.title, template.columns);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
