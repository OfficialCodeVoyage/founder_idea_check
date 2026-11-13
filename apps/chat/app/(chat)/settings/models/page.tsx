import { ExternalLink } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ModelsSettings } from "@/components/settings/models-settings";
import {
  SettingsPage,
  SettingsPageHeader,
} from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createModuleLogger } from "@/lib/logger";
import {
  getRequestQueryClient,
  getRequestSession,
} from "@/lib/request-session";
import { trpc } from "@/trpc/server";

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
  const initialPreferences = await readInitialPreferences();

  return (
    <SettingsPage>
      <ModelsSettingsHeader showRegistryLink />
      <ModelsSettings initialPreferences={initialPreferences} />
    </SettingsPage>
  );
}

/**
 * The saved preferences, read here and handed to `ModelsTable` as a prop so
 * its first render does not depend on the query cache (see `ModelsTable`).
 * `null` means "not known", never `[]`, which would read as "no saved
 * preferences".
 *
 * Signed out: `null` without a read. The settings layout redirects, but this
 * page renders alongside it, and `getModelPreferences` is a protected
 * procedure, so the read would only fail with UNAUTHORIZED. The session check
 * reuses the request's cached lookup (`getRequestSession`).
 *
 * Same request-scoped client as the layout's lazy prefetch, so the read joins
 * that fetch instead of starting another, and the layout's `HydrateClient`
 * already sends the query to the browser. Next's control-flow errors
 * propagate; any other failure is logged and gives `null`.
 */
async function readInitialPreferences() {
  const session = await getRequestSession();
  if (!session?.user) {
    return null;
  }
  const queryClient = await getRequestQueryClient();
  try {
    return await queryClient.fetchQuery(
      trpc.settings.getModelPreferences.queryOptions()
    );
  } catch (err) {
    unstable_rethrow(err);
    // `err`, not `error`: this pino serialises only `err` (type, message,
    // stack); under any other key an Error prints as its own fields.
    log.error({ err }, "Failed to read model preferences");
    return null;
  }
}
