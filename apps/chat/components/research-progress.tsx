import { Maximize2, Minimize2 } from "lucide-react";
import React from "react";
import { UpdateTitle } from "@/components/update-title";
import { cn } from "@/lib/utils";
// Type-only imports
import type { ResearchUpdate } from "@/tools/platform/research-updates-schema";
import { describeResearchRun, researchRunLine } from "./research-run-summary";
import { ResearchTask } from "./research-task";
import { ResearchTasks } from "./research-tasks";

// Add the updateName mapping (consider moving to a shared util later)
const updateName = {
  web: "Web Search",
  started: "Started",
  completed: "Completed",
  thoughts: "Thoughts",
  writing: "Writing",
  lanes: "Sources",
} as const;

export const ResearchProgress = ({
  updates,
  totalExpectedSteps: _totalExpectedSteps,
  isComplete,
}: {
  updates: ResearchUpdate[];
  totalExpectedSteps: number;
  isComplete: boolean;
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);

  const lastUpdate = updates.length > 0 ? updates.at(-1) : null;

  /*
    WHAT ACTUALLY RAN, AS A UNION — see components/research-run-summary.ts.

    This row used to be three independent numbers, each defaulting to 0, and on
    2026-08-21 it told a founder "Researched for 0 seconds, 0 searches, 0
    sources" about a run in which `deepResearch` never received a prompt and no
    search was ever attempted. Three zeros are indistinguishable from a search
    that ran and found nobody, which is the single most damaging thing this
    product can say by accident.
  */
  const run = React.useMemo(() => describeResearchRun(updates), [updates]);

  // TODO: First update is not showing
  const lastUpdateTitle = (() => {
    if (!lastUpdate) {
      return "Researching";
    }
    if (isComplete) {
      return "Research Complete";
    }
    return lastUpdate.title || updateName[lastUpdate.type];
  })();

  return (
    <div className="w-full rounded-lg border p-1">
      <button
        className={cn(
          "flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2",
          "transition-colors hover:bg-accent hover:text-accent-foreground"
        )}
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {isComplete ? (
              <span
                className={cn(
                  "text-xs",
                  run.searched ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {researchRunLine(run)}
              </span>
            ) : (
              <UpdateTitle isRunning={!isComplete} title={lastUpdateTitle} />
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <Minimize2
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
          ) : (
            <Maximize2
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
        </div>
      </button>

      {isExpanded ? (
        <div className="px-1 pt-2 pb-1">
          <ResearchTasks updates={updates} />
        </div>
      ) : (
        lastUpdate &&
        !isComplete && (
          <div className="px-4 pt-1 pb-3">
            {/* We only show the running step in this component */}
            <ResearchTask isRunning={true} minimal={true} update={lastUpdate} />
          </div>
        )
      )}
    </div>
  );
};
