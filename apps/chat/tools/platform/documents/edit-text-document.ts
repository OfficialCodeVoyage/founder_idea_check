import { tool } from "ai";
import { z } from "zod";
import { getOwnedDocumentById, saveDocument } from "@/lib/db/queries";
import { textGuidelines } from "./text-guidelines";
import type { DocumentToolContext, DocumentToolResult } from "./types";

export const editTextDocumentTool = ({
  session,
  messageId,
}: DocumentToolContext) =>
  tool({
    description: `Edit an existing text document with markdown support.

Use for editing:
- Essays, articles, blog posts, reports
- Documentation, guides, tutorials
- Emails, letters, formal writing
${textGuidelines}

Important: You must first read the document content before editing.

Avoid:
- Updating immediately after a document was just created
- Using this if there is no previous document in the conversation`,
    inputSchema: z.object({
      documentId: z.string().describe("The ID of the document to edit"),
      title: z.string().describe("Document title"),
      content: z.string().describe("The full updated markdown content"),
    }),

    async execute({ documentId, title, content }): Promise<DocumentToolResult> {
      // The model supplies `documentId`, and a prompt can steer it to any id
      // it has seen — including one from another user's shared chat. Only
      // the owner's document is found (`lib/db/queries.ts::firstVersionOwner`),
      // and "not yours" reads exactly like "missing". An anonymous session owns
      // no document, so it gets the same answer instead of a silent no-op that
      // reported success.
      const userId = session.user?.id;
      const document = userId
        ? await getOwnedDocumentById({ id: documentId, userId })
        : undefined;

      if (!(userId && document)) {
        return { status: "error", error: "Document not found" };
      }

      if (document.kind !== "text") {
        return { status: "error", error: "Document is not a text document" };
      }

      await saveDocument({
        id: documentId,
        title,
        content,
        kind: "text",
        userId,
        messageId,
      });

      return {
        status: "success",
        documentId,
        result: "The document was updated and is now visible to the user.",
        date: new Date().toISOString(),
      };
    },
  });
