import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { ProjectCanvas } from "@/components/canvas/project-canvas";
import { PersonaCard } from "@/components/persona/persona-card";
import { auth } from "@/lib/auth";
import { loadProjectCanvas } from "@/lib/project/canvas-data";

/**
 * The project canvas screen: facts, personas, artifacts and the tasks that
 * would unblock the current phase, on one surface.
 *
 * A SERVER COMPONENT, not a page, because two routes render it — see the note
 * on visibility in `app/(chat)/project/[projectId]/page.tsx`. The three pure
 * calls that produce the graph run in `loadProjectCanvas`, so the client
 * receives a decided graph rather than a raw verdict (CANVAS-INTEGRATION-NOTES
 * §4). `ProjectCanvas` itself composes and computes nothing.
 *
 * SPLIT INTO A STATIC SHELL AND A SUSPENDED BODY, the same shape
 * `app/(chat)/layout.tsx` uses. Everything below the frame depends on WHO IS
 * ASKING — the session, then a project only its owner may see — so with
 * `cacheComponents` on, reading it directly made the whole navigation
 * uncacheable and Next reported the route as unable to be instant.
 *
 * The fix is Suspense, NOT `"use cache"`. Caching a component that reads the
 * session would serve one founder's project to another; the dev overlay offers
 * that option generically and it is the one option this component must never
 * take. The frame renders immediately, the private part streams in.
 */
export function ProjectCanvasScreen({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-[calc(100dvh_-_var(--header-height))] min-h-0 flex-col">
      <Suspense fallback={<ProjectCanvasSkeleton />}>
        <ProjectCanvasContent projectId={projectId} />
      </Suspense>
    </div>
  );
}

/** The frame's contents while the private half is still loading. */
function ProjectCanvasSkeleton() {
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-baseline gap-2 border-b px-4 py-3">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="min-h-0 flex-1 animate-pulse bg-muted/30" />
    </>
  );
}

async function ProjectCanvasContent({ projectId }: { projectId: string }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    redirect("/");
  }

  const data = await loadProjectCanvas({
    projectId,
    userId: session.user.id,
  });
  // Null covers "no such project" AND "not yours", deliberately without
  // distinguishing them — the same posture phase.router.ts takes.
  if (!data) {
    notFound();
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-baseline gap-2 border-b px-4 py-3">
        <h1 className="font-medium text-base">{data.projectName}</h1>
        <span className="text-muted-foreground text-xs">
          Canvas · phase {data.phaseKey}
        </span>
      </div>

      <ProjectCanvas
        analysis={data.analysis}
        className="min-h-0 flex-1"
        graph={data.graph}
      />

      {/*
        The persona is a PROJECT-level artifact — it is regenerated from the
        fact store, not produced by one assistant turn — so the artifact panel,
        which is keyed by message, is not a place it can ever appear. This is.
        An unreadable version renders as a stated hole rather than vanishing,
        for the same reason orderPersonaVersions keeps it.
      */}
      {data.persona ? (
        <div className="max-h-[40dvh] shrink-0 overflow-y-auto border-t p-3">
          {data.persona.artifact ? (
            <PersonaCard
              artifact={data.persona.artifact}
              version={data.persona.version}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              Persona v{data.persona.version} could not be read. It was written
              by a different content version, so its relationship to the
              evidence it claims is unknown.
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}
