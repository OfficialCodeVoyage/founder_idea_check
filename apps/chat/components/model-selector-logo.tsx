"use client";
import { Cpu } from "lucide-react";
import { useMemo } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useChatModels } from "@/providers/chat-models-provider";

const FIRST_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * A MODEL PROVIDER'S MARK, DRAWN LOCALLY: THE FIRST LETTER OF ITS NAME, OR A CHIP.
 *
 * This used to be an `<img>` pointing at `models.dev/logos/<provider>.svg`, so
 * every page that renders the model selector made a third-party request from
 * the founder's browser. The app makes no third-party requests for its own UI:
 * the mark is a pure function of the provider id, drawn the same way the
 * source favicons are (`components/favicon.tsx`). The badge is decorative: the
 * model's name is always printed next to it, so it is hidden from assistive
 * technology.
 *
 * A provider id with no letter or digit in it (or no provider at all) gets a
 * generic chip rather than an empty box, so the rows keep their alignment.
 */
export const ModelSelectorLogo = ({
  modelId,
  className,
}: {
  modelId: string;
  className?: string;
}) => {
  const { getModelById } = useChatModels();
  const initial = useMemo(() => {
    const model = getModelById(modelId);
    const provider = model?.owned_by ?? modelId.split("/")[0] ?? "";
    return provider.match(FIRST_LETTER_OR_DIGIT)?.[0] ?? null;
  }, [getModelById, modelId]);

  return (
    <Avatar
      aria-hidden
      className={cn("size-4 rounded-sm [container-type:size]", className)}
    >
      <AvatarFallback className="rounded-none font-medium text-[62cqh] text-muted-foreground uppercase leading-none">
        {initial ?? <Cpu className="size-[70%]" />}
      </AvatarFallback>
    </Avatar>
  );
};
