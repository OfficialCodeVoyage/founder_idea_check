import { tool } from "ai";
import { z } from "zod";
import type { StreamWriter } from "@/lib/ai/types";
import { getOwnedDocumentById } from "@/lib/db/queries";
import type { ToolSession } from "./types";

interface ReadDocumentProps {
  dataStream: StreamWriter;
  session: ToolSession;
}

export const readDocument = ({
  session,
  dataStream: _dataStream,
}: ReadDocumentProps) =>
  tool({
    description: `Read the contents of a document created earlier in this chat.

Use for:
- Retrieve document text for follow-up analysis or questions

Avoid:
- Documents that were not produced in the current conversation`,
    inputSchema: z.object({
      documentId: z.string().describe("The ID of the document to read"),
    }),
    execute: async ({ documentId }) => {
      // Owner-scoped in the query (`lib/db/queries.ts::firstVersionOwner`).
      // This used to read the NEWEST version and compare its writer, so a
      // version appended by another user made that user the "owner" here and
      // locked the real owner out; it also answered "Unauthorized" for a
      // foreign id, which told the caller the id exists. Both now read as
      // "not found".
      const userId = session.user?.id;
      const document = userId
        ? await getOwnedDocumentById({ id: documentId, userId })
        : undefined;

      if (!document) {
        return {
          error: "Document not found",
        };
      }

      return {
        documentId: document.id,
        title: document.title,
        kind: document.kind,
        content: document.content,
        createdAt: document.createdAt,
      };
    },
  });
