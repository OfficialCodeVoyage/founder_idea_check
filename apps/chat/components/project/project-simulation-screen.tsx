import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { SimulationPanel } from "@/components/simulation/simulation-panel";
import { SimulationProfileForm } from "@/components/simulation/simulation-profile-form";
import { getProjectFacts } from "@/lib/db/phase-queries";
import { getProjectById } from "@/lib/db/queries";
import {
  getProjectPersonas,
  getSimulationProfiles,
  getSimulationRuns,
} from "@/lib/db/simulation-queries";
import { describeSeedGap } from "@/lib/personas/simulation-gaps";
import { toSimulationPersonas } from "@/lib/personas/simulation-input";
import { getRequestSession } from "@/lib/request-session";

/**
 * The project simulation screen: run a pitch past the seeded personas, and read
 * every past run including the ones that collapsed.
 *
 * Same shape as ProjectCanvasScreen — a static frame with the private half
 * behind Suspense — for the same two reasons: everything below depends on who
 * is asking, and `params` must not be awaited above the boundary or the shared
 * App Shell gets tied to one project id.
 */
export function ProjectSimulationScreen({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return (
    <div className="flex h-[calc(100dvh_-_var(--header-height))] min-h-0 flex-col">
      <Suspense fallback={<ProjectSimulationSkeleton />}>
        <ProjectSimulationContent params={params} />
      </Suspense>
    </div>
  );
}

function ProjectSimulationSkeleton() {
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-baseline gap-2 border-b px-4 py-3">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="min-h-0 flex-1 space-y-3 p-4">
        <div className="h-24 w-full animate-pulse rounded bg-muted/40" />
        <div className="h-8 w-40 animate-pulse rounded bg-muted/40" />
      </div>
    </>
  );
}

/**
 * The pitch a run defaults to.
 *
 * Built from the fact store rather than left blank, because an empty box invites
 * a founder to type a fresh sales line — and a simulation against a pitch that
 * exists nowhere else measures the pitch, not the project. Falls back to the
 * project's own instructions, and to nothing at all rather than to an invented
 * sentence.
 */
function defaultPitch(
  facts: readonly { key: string; value: string }[],
  instructions: string
): string {
  const named = ["one_liner", "value_proposition", "problem_statement"];
  for (const key of named) {
    const hit = facts.find((fact) => fact.key === key);
    if (hit?.value.trim()) {
      return hit.value.trim();
    }
  }
  return instructions.trim();
}

async function ProjectSimulationContent({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await getRequestSession();
  if (!session?.user) {
    redirect("/");
  }

  const project = await getProjectById({ id: projectId });
  // "No such project" and "not yours" are the same answer on purpose.
  if (!project || project.userId !== session.user.id) {
    notFound();
  }

  const [facts, history, versions, profiles] = await Promise.all([
    getProjectFacts({ projectId }),
    getSimulationRuns({ projectId }),
    getProjectPersonas({ projectId, userId: project.userId }),
    getSimulationProfiles({ projectId }),
  ]);

  // THE SAME PURE FUNCTION THE RUN USES, so the pre-flight banner and the
  // refusal-on-click can never disagree. Rendered before the pitch box, so the
  // founder sees what is missing as a prerequisite rather than as a failure.
  const seeded = toSimulationPersonas({ profiles, versions });

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-baseline gap-2 border-b px-4 py-3">
        <h1 className="font-medium text-base">{project.name}</h1>
        <span className="text-muted-foreground text-xs">Simulation</span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <SimulationProfileForm
          personas={versions.map((version) => ({
            // The stored title is the only honest name left for a row that will
            // not parse — toCanvasPersonaInput's existing rule.
            label: version.artifact?.persona.label ?? null,
            personaDocumentId: version.documentId,
            title: version.title,
          }))}
          profiles={profiles}
          projectId={projectId}
        />
        {seeded.ok ? null : (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">
              A simulation cannot run yet. What is missing:
            </p>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {seeded.gaps.map((gap) => (
                <li
                  key={`${gap.kind}:${gap.kind === "orphan-profile" ? gap.profileId : gap.personaDocumentId}`}
                >
                  {describeSeedGap(gap)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <SimulationPanel
          history={history}
          initialPitch={defaultPitch(facts, project.instructions)}
          projectId={projectId}
        />
      </div>
    </>
  );
}
