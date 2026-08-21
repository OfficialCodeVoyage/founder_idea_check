import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { FactRow } from "@/components/project/fact-row";
import { auth } from "@/lib/auth";
import { getProjectFacts } from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";
import { PHASES } from "@/lib/phases/definitions";

/**
 * The fact ledger, browsable and correctable.
 *
 * Facts used to exist only as nodes on the canvas graph. If the extractor wrote
 * a wrong one there was no way to fix it — and facts ground the persona, the
 * simulation and the export, and the gate counts them.
 *
 * Same shape as the other project screens: a static frame with the private half
 * behind Suspense, and `params` not awaited above the boundary.
 */
export function ProjectFactsScreen({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return (
    <div className="flex h-[calc(100dvh_-_var(--header-height))] min-h-0 flex-col">
      <Suspense fallback={<ProjectFactsSkeleton />}>
        <ProjectFactsContent params={params} />
      </Suspense>
    </div>
  );
}

function ProjectFactsSkeleton() {
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-baseline gap-2 border-b px-4 py-3">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="min-h-0 flex-1 space-y-2 p-4">
        <div className="h-16 w-full animate-pulse rounded bg-muted/40" />
        <div className="h-16 w-full animate-pulse rounded bg-muted/40" />
      </div>
    </>
  );
}

const PHASE_TITLE = new Map(PHASES.map((phase) => [phase.key, phase.title]));

async function ProjectFactsContent({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    redirect("/");
  }

  const project = await getProjectById({ id: projectId });
  // "No such project" and "not yours" are the same answer on purpose.
  if (!project || project.userId !== session.user.id) {
    notFound();
  }

  const facts = await getProjectFacts({ projectId });
  const founderCount = facts.filter((fact) => fact.origin === "founder").length;

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-baseline gap-2 border-b px-4 py-3">
        <h1 className="font-medium text-base">{project.name}</h1>
        <span className="text-muted-foreground text-xs">
          Facts ({facts.length})
        </span>
        {founderCount > 0 ? (
          <span className="text-muted-foreground text-xs">
            {founderCount} corrected by you
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mb-4 max-w-2xl text-muted-foreground text-sm">
          Everything the interview established, in the extractor's own words.
          These are what the gate counts, and what the persona, the simulation
          and the export are all built from — so a wrong one is worth fixing.
          Correcting a fact marks it as YOUR assertion rather than something a
          customer said, and the gate is told the difference.
        </p>

        {facts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing established yet. Facts are written by the extractor after a
            turn, so this fills up as the interview goes.
          </p>
        ) : (
          <ul className="space-y-2">
            {facts.map((fact) => (
              <FactRow
                confidence={fact.confidence}
                factKey={fact.key}
                key={fact.id}
                origin={fact.origin}
                phaseKey={PHASE_TITLE.get(fact.phaseKey) ?? fact.phaseKey}
                projectId={projectId}
                value={fact.value}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
