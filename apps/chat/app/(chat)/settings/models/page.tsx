import { ExternalLink } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ModelsSettings } from "@/components/settings/models-settings";
import {
  SettingsPage,
  SettingsPageHeader,
} from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createModuleLogger } from "@/lib/logger";
import { getQueryClient, HydrateClient, trpc } from "@/trpc/server";

const log = createModuleLogger("settings:models");

function ModelsSettingsHeader({
  showRegistryLink = false,
}: {
  showRegistryLink?: boolean;
}) {
  return (
    <SettingsPageHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="font-semibold text-lg">Models</h2>
        <p className="text-muted-foreground text-sm">
          Configure your AI model preferences.
        </p>
      </div>
      {showRegistryLink ? (
        <Button
          asChild
          className="w-full max-w-[300px] sm:w-auto"
          size="sm"
          variant="outline"
        >
          <a
            href="https://airegistry.app"
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalLink className="size-4" />
            <span>Models Registry</span>
          </a>
        </Button>
      ) : (
        <Skeleton className="h-8 w-full max-w-[300px] sm:w-36" />
      )}
    </SettingsPageHeader>
  );
}

export default function ModelsSettingsPage() {
  return (
    <Suspense
      fallback={
        <SettingsPage>
          <ModelsSettingsHeader />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-5/6" />
          </div>
        </SettingsPage>
      }
    >
      <ModelsSettingsContent />
    </Suspense>
  );
}

async function ModelsSettingsContent() {
  // A page renders alongside its layouts, not after them, so the layouts'
  // barrier does not cover this fetch: its tRPC context looks the session up,
  // and better-auth reads the clock (`lib/request-session.ts`). Sequential,
  // never inside a `Promise.all` (see `app/(chat)/layout.tsx`).
  await connection();
  const queryClient = getQueryClient();
  // Read here and handed to `ModelsTable` as a prop, so its first render
  // does not depend on the query cache (see `ModelsTable`). Same
  // request-scoped client as the layout's lazy prefetch, so this joins that
  // fetch instead of starting another. Next's control-flow errors propagate;
  // any other failure is logged and falls back to no saved preferences, which
  // renders the default model set.
  const initialPreferences = await queryClient
    .fetchQuery(trpc.settings.getModelPreferences.queryOptions())
    .catch((error: unknown) => {
      unstable_rethrow(error);
      log.error({ error }, "Failed to read model preferences");
      return [];
    });

  return (
    <HydrateClient>
      <SettingsPage>
        <ModelsSettingsHeader showRegistryLink />
        <ModelsSettings initialPreferences={initialPreferences} />
      </SettingsPage>
    </HydrateClient>
  );
}
