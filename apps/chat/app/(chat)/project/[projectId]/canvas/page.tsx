import { ProjectCanvasScreen } from "@/components/project/project-canvas-screen";

/**
 * The same canvas screen, at a path `app/(chat)/chat-route-host.tsx` does NOT
 * host.
 *
 * `parseChatIdFromPathname` matches `/project/:id` and `/project/:id/chat/:id`
 * and nothing else under `/project`, so this path falls through as
 * `passthrough` — and a passthrough route is the one case where ChatRouteHost
 * renders `children` directly instead of burying them in `<div hidden>`.
 *
 * This exists so the canvas is REACHABLE today. It is not a second
 * implementation: both routes render `<ProjectCanvasScreen />`. When the host
 * learns to render `/project/:id` itself, delete this file and nothing else
 * changes.
 */
export default function ProjectCanvasPageRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return <ProjectCanvasScreen params={params} />;
}
