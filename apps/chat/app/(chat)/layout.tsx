import { cookies } from "next/headers";
import { Suspense } from "react";
import { getChatModels } from "@/app/actions/get-chat-models";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatLoadingShell } from "@/components/chat-loading-shell";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { AppModelId } from "@/lib/ai/app-model-id";
import { config } from "@/lib/config";
import { isPlaywrightTestEnvironment } from "@/lib/constants";
import { getRequestSession } from "@/lib/request-session";
import { ANONYMOUS_LIMITS } from "@/lib/types/anonymous";
import { ChatModelsProvider } from "@/providers/chat-models-provider";
import { DefaultModelProvider } from "@/providers/default-model-provider";
import { SessionProvider, SessionSeed } from "@/providers/session-provider";
import { TRPCReactProvider } from "@/trpc/react";
import { getQueryClient, HydrateClient, trpc } from "@/trpc/server";
import { ChatProviders } from "./chat-providers";
import { ChatRouteHost } from "./chat-route-host";

const sidebarInsetClassName = "[--header-height:calc(var(--spacing)*13)]";

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value === "true";

  return (
    <TRPCReactProvider>
      <SessionProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <AppSidebar />
          <SidebarInset className={sidebarInsetClassName}>
            <Suspense fallback={<ChatLoadingShell />}>
              <ChatLayoutDynamic>{children}</ChatLayoutDynamic>
            </Suspense>
          </SidebarInset>
        </SidebarProvider>
      </SessionProvider>
    </TRPCReactProvider>
  );
}

async function ChatLayoutDynamic({ children }: { children: React.ReactNode }) {
  const [cookieStore, chatModels] = await Promise.all([
    cookies(),
    getChatModels(),
  ]);
  const session = isPlaywrightTestEnvironment
    ? null
    : await getRequestSession();

  const cookieModel = cookieStore.get("chat-model")?.value;
  const isAnonymous = !session?.user;

  const default_chat_model = config.ai.workflows.chat;
  let defaultModel: AppModelId =
    (cookieModel as AppModelId) ?? default_chat_model;

  if (cookieModel) {
    const modelExists = chatModels.some((m) => m.id === cookieModel);
    if (!modelExists) {
      defaultModel = default_chat_model;
    } else if (isAnonymous) {
      const isModelAvailable = (
        ANONYMOUS_LIMITS.AVAILABLE_MODELS as readonly AppModelId[]
      ).includes(cookieModel as AppModelId);
      if (!isModelAvailable) {
        defaultModel = default_chat_model;
      }
    }
  }

  if (isAnonymous) {
    const anonymousModels =
      ANONYMOUS_LIMITS.AVAILABLE_MODELS as readonly AppModelId[];
    if (!anonymousModels.includes(defaultModel)) {
      defaultModel = anonymousModels[0] ?? default_chat_model;
    }
  }

  if (session?.user?.id) {
    const queryClient = getQueryClient();
    // "Lazy prefetch": don't await; pending queries are dehydrated + streamed.
    queryClient.prefetchQuery(trpc.project.list.queryOptions());
    queryClient.prefetchQuery(
      trpc.chat.getAllChats.queryOptions({ projectId: null })
    );
    // Model preferences are awaited, not lazy. A second HydrationBoundary
    // carries the same query (`app/(chat)/settings/models/page.tsx::
    // ModelsSettingsContent`), and React Query's HydrationBoundary applies
    // data for a query already in the cache only in an effect after commit.
    // When this boundary streamed the query pending, the page's resolved copy
    // could not reach the first render, so `ModelsTable` showed data or its
    // loading skeleton depending on whether the streamed promise had settled
    // in that pass. The server and the browser settled it at different
    // moments, and hydration failed. Resolved here, both boundaries carry the
    // same data with the same `dataUpdatedAt`: this one hydrates during
    // render on both sides, and the page's is skipped as not newer. It also
    // gives `ChatModelsProvider` the user's model filter on first paint. The
    // cost is one indexed read before the layout renders (in dev also the
    // artificial delay of `trpc/init.ts::timingMiddleware`).
    await queryClient.prefetchQuery(
      trpc.settings.getModelPreferences.queryOptions()
    );
  }

  return (
    <HydrateClient>
      <SessionSeed session={session} />
      <ChatProviders>
        <ChatModelsProvider models={chatModels}>
          <DefaultModelProvider defaultModel={defaultModel}>
            <KeyboardShortcuts />
            <ChatRouteHost>{children}</ChatRouteHost>
          </DefaultModelProvider>
        </ChatModelsProvider>
      </ChatProviders>
    </HydrateClient>
  );
}
