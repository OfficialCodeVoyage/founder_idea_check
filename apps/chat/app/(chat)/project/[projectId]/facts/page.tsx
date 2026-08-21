import { ProjectFactsScreen } from "@/components/project/project-facts-screen";

/**
 * `/project/:id/facts`.
 *
 * Not a path `parseChatIdFromPathname` matches, so it classifies as
 * `passthrough` and ChatRouteHost renders it directly. `params` is passed down
 * unawaited so the App Shell stays shared across links.
 */
export default function ProjectFactsPageRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return <ProjectFactsScreen params={params} />;
}
