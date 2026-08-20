import { ProjectCanvasScreen } from "@/components/project/project-canvas-screen";

/**
 * The project route. Mounts the project canvas.
 *
 * ⚠️ VISIBILITY — READ THIS BEFORE ASSUMING THIS PAGE IS ON SCREEN.
 * `app/(chat)/chat-route-host.tsx` intercepts every path that
 * `parseChatIdFromPathname` classifies as hosted, which today includes
 * `projectHome` — i.e. THIS route. For those paths it draws a draft chat and
 * renders the page segment inside `<div hidden>`, so a component mounted here
 * is constructed but never seen. That is why `/project/:id` has looked like an
 * empty `return null` route: the host, not the page, decides what this URL
 * shows.
 *
 * Until the host learns about this segment, the canvas is ALSO mounted at
 * `/project/:id/canvas` — an unhosted `passthrough` path that renders the very
 * same component and is therefore actually visible. Changing which of the two
 * `/project/:id` shows is a product decision about what a project's home IS
 * (today it is "start a new chat in this project"), and it belongs to whoever
 * owns chat-route-host.tsx — not to a silent edit from here.
 */
export default function ProjectPageRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return <ProjectCanvasScreen params={params} />;
}
