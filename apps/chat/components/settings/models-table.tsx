"use client";

import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Table, TableBody } from "@/components/ui/table";
import type { AppModelId } from "@/lib/ai/app-model-id";
import { resolveEnabledModels } from "@/lib/ai/app-models";
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
  /** The server's read of the preferences; `null` when that read failed. */
  initialPreferences: UserModelPreference[] | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { allModels } = useChatModels();

  // The (chat) layout streams this query pending, and on first load the
  // server and the browser could each see it pending or resolved and render
  // different markup. The page reads the same rows on the server and passes
  // them in, and the table renders the query's data when it has some and
  // those rows otherwise, so both sides render the same thing and there is no
  // loading state. Not `placeholderData`: it stops applying once the query
  // errors with no data, and the table would drop to the defaults although it
  // holds the saved preferences. Not `initialData`: that is written into the
  // shared cache and marked fresh, which would hide an errored query from
  // `ChatModelsProvider`. With neither (the server read failed and the query
  // has nothing yet) the table renders the default model set.
  const { data: queryData } = useQuery(
    trpc.settings.getModelPreferences.queryOptions()
  );
  const preferences = queryData ?? initialPreferences;

  const queryKey = trpc.settings.getModelPreferences.queryKey();
  const mutationKey = trpc.settings.setModelEnabled.mutationKey();

  const { mutate: setModelEnabled } = useMutation(
    trpc.settings.setModelEnabled.mutationOptions({
      onMutate: async (newData) => {
        // Stop an in-flight read from landing on top of the optimistic value.
        await queryClient.cancelQueries({ queryKey });
        const prev = queryClient.getQueryData(queryKey);
        // While the table renders `initialPreferences` the cache is empty;
        // build on what is shown rather than skipping the update, or the
        // switch would not move and a second click would flip it back.
        queryClient.setQueryData(queryKey, (cached) => {
          const old = cached ?? initialPreferences ?? [];
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
        if (context?.prev === undefined) {
          // Nothing was cached before the toggle, and `setQueryData` ignores
          // `undefined`: reset the query, so the table falls back to
          // `initialPreferences` (or the defaults) until it refetches.
          queryClient.resetQueries({ queryKey });
        } else {
          queryClient.setQueryData(queryKey, context.prev);
        }
        toast.error("Failed to update model preference");
      },
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey });
      },
    })
  );

  // A row's switch is disabled while its own toggle is in flight: `onMutate`
  // awaits `cancelQueries` before the optimistic write, so a fast second
  // click would still read the old value and send the same change twice.
  const pendingModelIds = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) =>
      (mutation.state.variables as { modelId?: string } | undefined)?.modelId,
  });
  const pendingModelIdSet = useMemo(
    () => new Set(pendingModelIds),
    [pendingModelIds]
  );

  const enabledModelsSet = useMemo(
    () => resolveEnabledModels(allModels, preferences),
    [allModels, preferences]
  );

  // Row order: enabled models first, then the rest, fixed once from real data
  // and kept, so a row does not jump when it is toggled. Real data is
  // `initialPreferences`, or, when the server read failed, the query's first
  // data. Until then the table orders by the defaults without fixing that
  // order; server and first client render both have the same input, so they
  // agree. Built from what this table renders, not from
  // `useChatModels().models`, whose query can be pending on one side and
  // resolved on the other.
  const fixedOrderRef = useRef<AppModelId[] | null>(null);
  const sortedModels = useMemo(() => {
    if (fixedOrderRef.current === null) {
      const sorted = [
        ...allModels.filter((m) => enabledModelsSet.has(m.id)),
        ...allModels.filter((m) => !enabledModelsSet.has(m.id)),
      ];
      if (preferences !== null && preferences !== undefined) {
        fixedOrderRef.current = sorted.map((m) => m.id);
      }
      return sorted;
    }
    const modelMap = new Map(allModels.map((m) => [m.id, m]));
    return fixedOrderRef.current
      .map((id) => modelMap.get(id))
      .filter((m) => m !== undefined);
  }, [allModels, enabledModelsSet, preferences]);

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
              isPending={pendingModelIdSet.has(model.id)}
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
