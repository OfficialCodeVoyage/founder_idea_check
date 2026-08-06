import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import type { ChatMessage } from "@/lib/ai/types";
import { auth } from "@/lib/auth";
import {
  getChatById,
  getMessageById,
  getProjectById,
  getUserById,
  saveChatIfNotExists,
  saveMessageIfNotExists,
} from "@/lib/db/queries";
import { createModuleLogger } from "@/lib/logger";
import { generateTitleFromUserMessage } from "../../../actions";

const log = createModuleLogger("api:chat:prepare");

type PrepareRequestBody = {
  id: string;
  message: ChatMessage;
  projectId?: string;
};

async function requirePrepareUser(chatId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;

  if (!userId) {
    log.warn({ chatId }, "POST /api/chat/prepare unauthenticated");
    return {
      error: new Response("Authentication required", {
        status: 401,
      }),
    };
  }

  const user = await getUserById({ userId });
  if (!user) {
    log.warn({ chatId, userId }, "POST /api/chat/prepare user not found");
    return { error: new Response("User not found", { status: 404 }) };
  }

  return { userId };
}

async function validatePrepareProject({
  chatId,
  projectId,
  userId,
}: {
  chatId: string;
  projectId?: string;
  userId: string;
}) {
  if (!projectId) {
    return null;
  }

  const project = await getProjectById({ id: projectId });
  if (!project || project.userId !== userId) {
    log.warn(
      {
        chatId,
        userId,
        projectId,
        hasProject: !!project,
        projectUserId: project?.userId ?? null,
      },
      "POST /api/chat/prepare project ownership mismatch"
    );
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

async function ensurePrepareChat({
  chatId,
  projectId,
  userId,
  userMessage,
}: {
  chatId: string;
  projectId?: string;
  userId: string;
  userMessage: ChatMessage;
}) {
  const chat = await getChatById({ id: chatId });

  if (chat) {
    if (chat.userId !== userId) {
      log.warn(
        {
          chatId,
          userId,
          chatUserId: chat.userId,
        },
        "POST /api/chat/prepare chat ownership mismatch"
      );
      return { error: new Response("Unauthorized", { status: 401 }) };
    }

    return { isNewChat: false };
  }

  const projectError = await validatePrepareProject({
    chatId,
    projectId,
    userId,
  });
  if (projectError) {
    return { error: projectError };
  }

  const title = await generateTitleFromUserMessage({
    message: userMessage,
  });

  await saveChatIfNotExists({
    id: chatId,
    userId,
    title,
    projectId,
  });

  return { isNewChat: true };
}

async function savePrepareUserMessage({
  chatId,
  userMessage,
}: {
  chatId: string;
  userMessage: ChatMessage;
}) {
  const [existingMessage] = await getMessageById({ id: userMessage.id });

  if (existingMessage && existingMessage.chatId !== chatId) {
    log.warn(
      {
        chatId,
        userMessageId: userMessage.id,
        existingMessageChatId: existingMessage.chatId,
      },
      "POST /api/chat/prepare message chatId mismatch"
    );
    return new Response("Unauthorized", { status: 401 });
  }

  await saveMessageIfNotExists({
    id: userMessage.id,
    chatId,
    message: userMessage,
  });

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const {
      id: chatId,
      message: userMessage,
      projectId,
    }: PrepareRequestBody = await request.json();

    if (!userMessage) {
      log.warn(
        {
          chatId,
          projectId: projectId ?? null,
        },
        "POST /api/chat/prepare missing user message"
      );
      return new Response("Missing user message", { status: 400 });
    }

    const userResult = await requirePrepareUser(chatId);
    if ("error" in userResult) {
      return userResult.error;
    }

    const chatResult = await ensurePrepareChat({
      chatId,
      projectId,
      userId: userResult.userId,
      userMessage,
    });
    if ("error" in chatResult) {
      return chatResult.error;
    }

    const messageError = await savePrepareUserMessage({ chatId, userMessage });
    if (messageError) {
      return messageError;
    }

    return Response.json({ isNewChat: chatResult.isNewChat });
  } catch (error) {
    log.error({ error }, "POST /api/chat/prepare failed");
    return new Response("Internal Server Error", { status: 500 });
  }
}
