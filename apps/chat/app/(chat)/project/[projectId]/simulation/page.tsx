import { ProjectSimulationScreen } from "@/components/project/project-simulation-screen";

/**
 * `/project/:id/simulation`.
 *
 * Like the canvas route, this path is not one `parseChatIdFromPathname` matches,
 * so it classifies as `passthrough` and ChatRouteHost renders it directly
 * instead of burying it in `<div hidden>`.
 *
 * `params` is passed down unawaited so the App Shell stays shared across links.
 */
export default function ProjectSimulationPageRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return <ProjectSimulationScreen params={params} />;
}
