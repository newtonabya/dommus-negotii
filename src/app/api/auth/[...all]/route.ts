import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/shell/auth/auth";

export const { GET, POST } = toNextJsHandler(auth);
