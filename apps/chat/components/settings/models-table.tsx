"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Table, TableBody } from "@/components/ui/table";
import type { AppModelId } from "@/lib/ai/app-model-id";
import { getDefaultEnabledModels } from "@/lib/ai/app-models";
import type { UserModelPreference } from "@/lib/db/schema";
import { useChatModels } from "@/providers/chat-models-provider";
import { useTRPC } from "@/trpc/react";
import { ModelRow } from "./model-row";

export function ModelsTable({
  search,
  className,
  initialPreferences,
}: {
  search: string;
  className?: string;
  initialPreferences: UserModelPreference[];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { allModels } = useChatModels();

  // The (chat) layout streams this query pending and the page dehydrates it
  // resolved, but HydrationBoundary applies a query already in the cache only
  // in an effect, so on first load the server and the browser could each see
  // it pending or resolved and render different markup. The page reads the
  // same rows on the server and passes them in; while the query is pending
  // they stand in for it, so both sides render those rows and there is no
  // loading state. `placeholderData` rather than `initialData`: initialData
  // is written into the shared cache during render and marked fresh, which
  // would also overwrite an errored query and hide the error from
  // `ChatModelsProvider`; placeholderData only shapes this component's result.
  // If the server read failed the prop is empty, and pending, errored and
  // empty all render the default model set.
  const { data: preferences } = useQuery({
    ...trpc.settings.getModelPreferences.queryOptions(),
    placeholderData: initialPreferences,
  });

  const queryKey = trpc.settings.getModelPreferences.queryKey();

  const { mutate: setModelEnabled } = useMutation(
    trpc.settings.setModelEnabled.mutationOptions({
      onMutate: async (newData) => {
        // Stop an in-flight read from landing on top of the optimistic value.
        await queryClient.cancelQueries({ queryKey });
        const prev = queryClient.getQueryData(queryKey);
        // While the table shows `initialPreferences` as placeholder data the
        // cache is empty; build on those rows rather than skipping the update,
        // or the switch would not move and a second click would flip it back.
        queryClient.setQueryData(queryKey, (cached) => {
          const old = cached ?? initialPreferences;
          const idx = old.findIndex((p) => p.modelId === newData.modelId);
          if (idx >= 0) {
            return old.with(idx, { ...old[idx], enabled: newData.enabled });
          }
          return [
            ...old,
            {
              modelId: newData.modelId,
              enabled: newData.enabled,
              userId: "",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ];
        });
        return { prev };
      },
      onError: (_err, _newData, context) => {
        // With nothing cached before the toggle there is nothing to restore
        // (`setQueryData` ignores `undefined`); `onSettled` refetches instead.
        queryClient.setQueryData(queryKey, context?.prev);
        toast.error("Failed to update model preference");
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey });
      },
    })
  );

  const enabledModelsSet = useMemo(() => {
    const enabled = getDefaultEnabledModels(allModels);
    for (const pref of preferences ?? []) {
      if (pref.enabled) {
        enabled.add(pref.modelId as AppModelId);
      } else {
        enabled.delete(pref.modelId as AppModelId);
      }
    }
    return enabled;
  }, [allModels, preferences]);

  // Stable sort order, computed once on the first render and kept, so a row
  // does not jump when it is toggled: enabled models first, then the rest.
  // Built from `enabledModelsSet`, the same preferences this table renders,
  // not from `useChatModels().models`: that query has no placeholder and can
  // be pending on the server but resolved in the browser (or the reverse),
  // which would order the rows differently on each side and freeze the order
  // on the default set.
  const initialSortRef = useRef<AppModelId[] | null>(null);
  const sortedModels = useMemo(() => {
    if (initialSortRef.current === null) {
      const sorted = [
        ...allModels.filter((m) => enabledModelsSet.has(m.id)),
        ...allModels.filter((m) => !enabledModelsSet.has(m.id)),
      ];
      initialSortRef.current = sorted.map((m) => m.id);
      return sorted;
    }
    const modelMap = new Map(allModels.map((m) => [m.id, m]));
    return initialSortRef.current
      .map((id) => modelMap.get(id))
      .filter((m) => m !== undefined);
  }, [allModels, enabledModelsSet]);

  const filteredModels = useMemo(() => {
    if (!search.trim()) {
      return sortedModels;
    }
    const q = search.toLowerCase();
    return sortedModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.owned_by?.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
    );
  }, [sortedModels, search]);

  const handleToggle = useCallback(
    (modelId: string, currentlyEnabled: boolean) => {
      setModelEnabled({
        modelId,
        enabled: !currentlyEnabled,
      });
    },
    [setModelEnabled]
  );

  return (
    <>
      <p className="mb-2 text-muted-foreground text-xs">
        {filteredModels.length} model{filteredModels.length !== 1 && "s"}
      </p>
      <Table className={className}>
        <TableBody>
          {filteredModels.map((model) => (
            <ModelRow
              isEnabled={enabledModelsSet.has(model.id)}
              key={model.id}
              model={model}
              onToggle={handleToggle}
            />
          ))}
        </TableBody>
      </Table>

      {filteredModels.length === 0 && (
        <p className="py-8 text-center text-muted-foreground text-sm">
          No models found.
        </p>
      )}
    </>
  );
}
