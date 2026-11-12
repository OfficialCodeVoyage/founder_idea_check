import { tool } from "ai";
import { z } from "zod";
import { getOwnedDocumentById, saveDocument } from "@/lib/db/queries";
import { sheetGuidelines } from "./sheet-guidelines";
import type { DocumentToolContext, DocumentToolResult } from "./types";

export const editSheetDocumentTool = ({
  session,
  messageId,
}: DocumentToolContext) =>
  tool({
    description: `Edit an existing spreadsheet document in CSV format.

Use for editing:
- Data tables and datasets
- Lists with multiple columns
- Financial data, statistics
- Any tabular information
${sheetGuidelines}

Important: You must first read the document content before editing.

Avoid:
- Updating immediately after a document was just created
- Using this if there is no previous document in the conversation`,
    inputSchema: z.object({
      documentId: z.string().describe("The ID of the document to edit"),
      title: z.string().describe("Spreadsheet title"),
      content: z.string().describe("The full updated CSV content"),
    }),

    async execute({ documentId, title, content }): Promise<DocumentToolResult> {
      // Owner-scoped for the reason given in `editTextDocumentTool`: the model
      // picks `documentId`, and "not yours" must read exactly like "missing".
      const userId = session.user?.id;
      const document = userId
        ? await getOwnedDocumentById({ id: documentId, userId })
        : undefined;

      if (!(userId && document)) {
        return { status: "error", error: "Document not found" };
      }

      if (document.kind !== "sheet") {
        return { status: "error", error: "Document is not a spreadsheet" };
      }

      await saveDocument({
        id: documentId,
        title,
        content,
        kind: "sheet",
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
