import { connection } from "next/server";
import { Suspense } from "react";
import { ChatLoadingShell } from "@/components/chat-loading-shell";
import { HydrateClient, prefetch, trpc } from "@/trpc/server";
import { SharedChatPage } from "./shared-chat-page";

export default function SharedChatPageRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<ChatLoadingShell />}>
      <SharedChatPageContent params={params} />
    </Suspense>
  );
}

async function SharedChatPageContent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Before the prefetch: its tRPC context looks the session up without a
  // barrier, and this page renders alongside the layouts that have one
  // (`lib/request-session.ts`, `trpc/init.ts::createTRPCContext`).
  await connection();
  // Prefetch the queries used in shared-chat-page.tsx
  prefetch(trpc.chat.getPublicChat.queryOptions({ chatId: id }));
  prefetch(trpc.chat.getPublicChatMessages.queryOptions({ chatId: id }));

  return (
    <HydrateClient>
      <SharedChatPage id={id} />
    </HydrateClient>
  );
}
