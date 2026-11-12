import { memo } from "react";
import { useMessageResearchUpdatePartsById } from "@/lib/stores/hooks-base";
import type { ResearchUpdate } from "@/tools/platform/research-updates-schema";
import { ReasonSearchResearchProgress } from "../deep-research-progress";
import { uniqueSources } from "../research-run-summary";
import { Sources } from "../sources";

export const SourcesAnnotations = memo(
  ({ messageId }: { messageId: string }) => {
    const parts = useMessageResearchUpdatePartsById(messageId);

    const researchUpdates = parts.map((u) => u.data);

    if (researchUpdates.length === 0) {
      return null;
    }

    const researchCompleted = researchUpdates.find(
      (u) => u.type === "completed"
    );

    if (!researchCompleted) {
      return null;
    }

    // The same list the run header counts (`describeResearchRun`), so the chip
    // and the header cannot disagree about how many sources there are.
    return <Sources sources={uniqueSources(researchUpdates)} />;
  }
);

SourcesAnnotations.displayName = "SourcesAnnotations";

// Render a given list of research updates (already grouped/filtered)
export const ResearchUpdates = ({
  updates,
}: {
  updates: ResearchUpdate[] | undefined;
}) => {
  if (!updates || updates.length === 0) {
    return null;
  }
  return <ReasonSearchResearchProgress updates={updates} />;
};
