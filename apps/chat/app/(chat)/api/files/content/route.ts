import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { createFileContentResponse } from "@/lib/file-content-response";

// proxy.ts does not guard /api/*: this handler reads the session itself, and
// createFileContentResponse decides access (lib/file-access.ts::canReadStoredFile).
// A signed-out request is not refused here: a reader of a shared chat is
// served the files that chat's owner put in it, through the chat id the link
// carries.
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  return await createFileContentResponse(request, session?.user?.id ?? null);
}
