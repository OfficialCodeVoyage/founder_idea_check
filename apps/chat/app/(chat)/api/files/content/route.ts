import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { createFileContentResponse } from "@/lib/file-content-response";

// proxy.ts does not guard /api/*: this handler checks the session itself, and
// createFileContentResponse serves only files the caller stored.
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }
  return await createFileContentResponse(request, userId);
}
