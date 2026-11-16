/**
 * Prints the permission table the app enforces, as JSON ({ action, roles }[]),
 * for make-testing-guide.py. Run: npx --yes tsx@4.23.15 scripts/demo/export-permissions.mts
 */
const { PERMISSIONS } = await import("@/shell/rbac/permissions");
const out = Object.entries(PERMISSIONS as unknown as Record<string, { roles: string[] }>).map(([action, p]) => ({ action, roles: p.roles }));
process.stdout.write(JSON.stringify(out));
