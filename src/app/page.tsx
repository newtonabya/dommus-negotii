import { redirect } from "next/navigation";
import { loadCurrentUser } from "@/shell/auth/session";

export const dynamic = "force-dynamic";

/** Sends each visitor to the right place: sign-in, the staff area or the member area. */
export default async function Home() {
  const result = await loadCurrentUser();
  if ("problem" in result) redirect(`/sign-in${result.problem === "signed-out" ? "" : `?reason=${result.problem}`}`);
  redirect(result.user.isStaff ? "/staff" : "/member");
}
