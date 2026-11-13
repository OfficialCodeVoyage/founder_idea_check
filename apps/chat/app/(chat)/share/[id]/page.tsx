import { Suspense } from "react";
import { ChatLoadingShell } from "@/components/chat-loading-shell";
import { getRequestQueryClient, HydrateClient, trpc } from "@/trpc/server";
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

  const queryClient = await getRequestQueryClient();
  // Prefetch the queries used in shared-chat-page.tsx
  queryClient.prefetchQuery(
    trpc.chat.getPublicChat.queryOptions({ chatId: id })
  );
  queryClient.prefetchQuery(
    trpc.chat.getPublicChatMessages.queryOptions({ chatId: id })
  );

  return (
    <HydrateClient>
      <SharedChatPage id={id} />
    </HydrateClient>
  );
}
