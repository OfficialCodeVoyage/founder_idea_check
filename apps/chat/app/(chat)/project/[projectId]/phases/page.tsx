import { ProjectPhasesScreen } from "@/components/project/project-phases-screen";

/**
 * `/project/:id/phases`.
 *
 * Like the canvas and simulation routes, this path is not one
 * `parseChatIdFromPathname` matches, so it classifies as `passthrough` and
 * ChatRouteHost renders it directly instead of burying it in `<div hidden>`.
 *
 * `params` is passed down unawaited so the App Shell stays shared across links.
 */
export default function ProjectPhasesPageRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return <ProjectPhasesScreen params={params} />;
}
