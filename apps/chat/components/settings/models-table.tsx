"use client";

import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Table, TableBody } from "@/components/ui/table";
import type { AppModelId } from "@/lib/ai/app-model-id";
import { getDefaultEnabledModels } from "@/lib/ai/app-models";
import { useChatModels } from "@/providers/chat-models-provider";
import { useTRPC } from "@/trpc/react";
import { ModelRow } from "./model-row";

export function ModelsTable({
  search,
  className,
}: {
  search: string;
  className?: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { allModels, models: enabledModels } = useChatModels();

  // Suspends instead of rendering a loading state. The (chat) layout streams
  // this query pending and the page dehydrates it resolved, but
  // HydrationBoundary applies a query already in the cache only in an effect,
  // so on first load the server and the browser could each see it pending or
  // resolved and render different markup. While a hydrating component
  // suspends, React keeps the server HTML and hydrates once the data is in,
  // so both sides render the same table and no skeleton flashes.
  const { data: preferences } = useSuspenseQuery(
    trpc.settings.getModelPreferences.queryOptions()
  );

  const queryKey = trpc.settings.getModelPreferences.queryKey();

  const { mutate: setModelEnabled } = useMutation(
    trpc.settings.setModelEnabled.mutationOptions({
      onMutate: (newData) => {
        const prev = queryClient.getQueryData(queryKey);
        queryClient.setQueryData(queryKey, (old) => {
          if (!old) {
            return old;
          }
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
        queryClient.setQueryData(queryKey, context?.prev);
        toast.error("Failed to update model preference");
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey });
      },
    })
  );

  const enabledModelsSet = useMemo(() => {
    const enabled = getDefaultEnabledModels(allModels);
    for (const pref of preferences) {
      if (pref.enabled) {
        enabled.add(pref.modelId as AppModelId);
      } else {
        enabled.delete(pref.modelId as AppModelId);
      }
    }
    return enabled;
  }, [allModels, preferences]);

  // Stable sort order: computed once on initial load, never changes
  const initialSortRef = useRef<AppModelId[] | null>(null);
  const sortedModels = useMemo(() => {
    if (initialSortRef.current === null) {
      // First render: enabled models first, then the rest
      const enabledSet = new Set(enabledModels.map((m) => m.id));
      const sorted = [
        ...enabledModels,
        ...allModels.filter((m) => !enabledSet.has(m.id)),
      ];
      initialSortRef.current = sorted.map((m) => m.id);
      return sorted;
    }
    // Subsequent renders: maintain original order
    const modelMap = new Map(allModels.map((m) => [m.id, m]));
    return initialSortRef.current
      .map((id) => modelMap.get(id))
      .filter((m) => m !== undefined);
  }, [allModels, enabledModels]);

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
