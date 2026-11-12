import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import type { ChatMessage } from "@/lib/ai/types";
import { auth } from "@/lib/auth";
import { getCredits } from "@/lib/db/credits";
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

/**
 * The least balance on which a new chat is titled here: 1¢ for the title's own
 * rounded charge, and 1¢ left so the turns that follow pass `/api/chat`'s
 * positive-balance check. See `ensurePrepareChat`.
 */
const PREPARE_MIN_BALANCE_CENTS = 2;

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

  // CREDITS BEFORE THE TITLE. The title is a charged model call
  // (`app/(chat)/actions.ts::generateTitleFromUserMessage`) and this route had
  // no credit check at all, so a script could buy title calls here at zero
  // credits by posting fresh chat ids. Same 402 as `/api/chat`, and checked
  // after the ownership checks so an unauthorised request still gets its 401.
  //
  // THE BAR IS ONE CENT ABOVE `/api/chat`'s. This route is the first step of
  // a parallel send (`lib/parallel-chat-requests.ts::runParallelRequestSpecs`),
  // and the title here is charged on its own, rounded up to 1¢. A founder with
  // exactly 1¢ would pay it and then have every turn of the same send refused
  // with 402 at 0¢. Refusing here instead costs them nothing. It holds while a
  // title costs at most 1¢ before rounding, which on the title model takes a
  // first message of tens of thousands of tokens to break.
  if ((await getCredits(userId)) < PREPARE_MIN_BALANCE_CENTS) {
    log.warn({ chatId, userId }, "POST /api/chat/prepare insufficient credits");
    return { error: new Response("Insufficient credits", { status: 402 }) };
  }

  const title = await generateTitleFromUserMessage({
    message: userMessage,
    userId,
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
