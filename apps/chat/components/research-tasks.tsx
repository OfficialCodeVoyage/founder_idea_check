import {
  CircleCheck,
  Dot,
  FileText,
  Layers,
  Pencil,
  Sparkles,
} from "lucide-react";
import { motion } from "motion/react";
import type React from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ResearchUpdate } from "@/tools/platform/research-updates-schema";
import { ResearchTask } from "./research-task";

/**
 * A KEY PER STEP — AND `toolCallId` IS NOT ONE.
 *
 * `updates` is every `data-researchUpdate` part of ONE tool call
 * (`useMessageResearchUpdatePartByToolCallId`), so by construction they all
 * share a `toolCallId`: the pipeline, the supervisor and the researcher agents
 * write `started`, `thoughts`, `web`, `lanes`, `writing` and `completed` under
 * the one id of the `deepResearch` call that ran them
 * (`tools/platform/deep-research/pipeline.ts`, `supervisor-agent.ts`,
 * `researcher-agent.ts`, `sidecar-search.ts`). Keying on it gave every step but
 * the first a duplicate key as soon as a run had two of them, which is every
 * run.
 *
 * The update carries no id of its own (the part-level `id` that reconciles a
 * `web` update from running to completed is not copied into `data`), so the key
 * is the call, the kind of step, and which one of that kind this is. The list
 * only ever grows at the end and a `web` update is replaced in place, so an
 * existing step keeps its ordinal for the life of the run and React keeps its
 * state (the open/closed `ResearchTask`) when a later step arrives.
 */
function stepKeys(updates: ResearchUpdate[]): string[] {
  const seen = new Map<string, number>();
  return updates.map((update) => {
    const kind = `${update.toolCallId}:${update.type}`;
    const ordinal = seen.get(kind) ?? 0;
    seen.set(kind, ordinal + 1);
    return `${kind}:${ordinal}`;
  });
}

export const ResearchTasks = ({ updates }: { updates: ResearchUpdate[] }) => {
  const keys = stepKeys(updates);
  return (
    <div className="relative">
      {updates.map((update, index) => (
        <StepWrapper
          isLast={index === updates.length - 1}
          key={keys[index]}
          update={update}
        >
          <ResearchTask
            isRunning={
              (update.type === "web" && update.status === "running") ||
              (index === updates.length - 1 && update.type !== "completed")
            }
            minimal={false}
            update={update}
          />
        </StepWrapper>
      ))}
    </div>
  );
};

interface StepWrapperProps {
  children: ReactNode;
  isLast: boolean;
  update: ResearchUpdate;
}

const StepWrapper = ({ update, children, isLast }: StepWrapperProps) => (
  <div className="flex w-full flex-row items-stretch justify-start gap-2">
    <div className="flex min-h-full shrink-0 flex-col items-center justify-start px-2">
      <div className="h-1 shrink-0 bg-border/50" />
      <div className="z-10 bg-background py-0.5">
        <StepTypeIcon update={update} />
      </div>
      <motion.div
        animate={{ height: "100%" }}
        className={cn(
          "min-h-full w-px flex-1 border-border border-l border-dashed",
          isLast && "hidden"
        )}
        initial={{ height: 0 }}
        transition={{ duration: 0.5 }}
      />
    </div>
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="flex w-full flex-1 flex-col gap-4 overflow-hidden pt-1 pr-2 pb-2"
      initial={{ opacity: 0, y: 5 }}
      transition={{ duration: 0.3 }}
    >
      {children}
    </motion.div>
  </div>
);

const icons: Record<ResearchUpdate["type"], React.ElementType> = {
  web: FileText,
  started: Dot,
  completed: CircleCheck,
  thoughts: Sparkles,
  writing: Pencil,
  // `lanes` updates are filtered out before the timeline in
  // components/part/deep-research.tsx — which lanes ran is rendered on its own,
  // not behind the expander. The entry exists so the Record stays exhaustive.
  lanes: Layers,
} as const;

const StepTypeIcon = ({ update }: { update: ResearchUpdate }) => {
  const Icon = icons[update.type];
  return <Icon className="h-4 w-4 text-muted-foreground" />;
};
