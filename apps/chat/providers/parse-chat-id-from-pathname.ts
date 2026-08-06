export type ChatRouteSource = "chat" | "home" | "project" | "share";

export type ParsedChatIdFromPathname =
  | {
      type: "home";
      id: null;
      source: "home";
      projectId: null;
    }
  | {
      type: "projectHome";
      id: null;
      source: "project";
      projectId: string;
    }
  | {
      type: "chat";
      id: string;
      source: "chat";
      projectId: null;
    }
  | {
      type: "projectChat";
      id: string;
      source: "project";
      projectId: string;
    }
  | {
      type: "share";
      id: string;
      source: "share";
      projectId: null;
    }
  | {
      type: "passthrough";
      id: null;
      source: null;
      projectId: null;
    };

const SHARE_ROUTE_PATTERN = /^\/share\/([^/]+)$/;
const PROJECT_ROUTE_PATTERN = /^\/project\/([^/]+)(?:\/chat\/([^/]+))?$/;
const CHAT_ROUTE_PATTERN = /^\/chat\/([^/]+)$/;

/**
 * Parse a Next.js pathname into the chat route shape.
 * Unknown paths are passthrough routes and must not become draft chats.
 */
export function parseChatIdFromPathname(
  pathname: string | null
): ParsedChatIdFromPathname {
  const shareMatch = pathname?.match(SHARE_ROUTE_PATTERN);
  if (shareMatch) {
    return {
      type: "share",
      id: shareMatch[1],
      source: "share",
      projectId: null,
    };
  }

  const projectMatch = pathname?.match(PROJECT_ROUTE_PATTERN);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const chatId = projectMatch[2];
    if (chatId) {
      return { type: "projectChat", id: chatId, source: "project", projectId };
    }
    return { type: "projectHome", id: null, source: "project", projectId };
  }

  const chatMatch = pathname?.match(CHAT_ROUTE_PATTERN);
  if (chatMatch) {
    return { type: "chat", id: chatMatch[1], source: "chat", projectId: null };
  }

  if (pathname === "/") {
    return { type: "home", id: null, source: "home", projectId: null };
  }

  return { type: "passthrough", id: null, source: null, projectId: null };
}
