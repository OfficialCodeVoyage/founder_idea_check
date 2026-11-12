"use client";

import { AlertTriangle, FileWarning, PlayCircle } from "lucide-react";
import { memo, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useArtifact } from "@/hooks/use-artifact";
import type { ChatMessage } from "@/lib/ai/types";
import {
  describeInputStream,
  hasInputStreamEnded,
  type InputStreamVerdict,
  partialDocumentBody,
  partialDocumentTitle,
} from "@/lib/artifacts/text/salvage";
import { config } from "@/lib/config";
import {
  useChatActions,
  useChatStatus,
  useChatStoreApi,
} from "@/lib/stores/base";
import {
  useLastMessageId,
  useMessageMetadataById,
} from "@/lib/stores/hooks-base";
import { useIsLastArtifact } from "@/lib/stores/hooks-message-parts";
import {
  type DocumentToolType,
  getToolKind,
  isEditTool,
} from "@/tools/platform/documents/types";
import { DocumentPreview } from "./document-preview";

type DocumentTool = Extract<
  ChatMessage["parts"][number],
  { type: DocumentToolType }
>;

interface DocumentToolComponentProps {
  isReadonly: boolean;
  messageId: string;
  tool: DocumentTool;
}

type DeadStream = Extract<InputStreamVerdict, { died: true }>;

/**
 * The panel fields for the copy rebuilt from the message itself: the
 * "[PARTIAL]" title and the bannered body, as `text` because the banner is
 * markdown. Shared by the button and by the settle effect below so the two
 * can never show different copies of the same partial.
 */
function unsavedCopyFields(
  salvage: Extract<DeadStream["salvage"], { salvaged: true }>
) {
  return {
    documentId: "init",
    title: partialDocumentTitle(salvage.title),
    content: partialDocumentBody(salvage),
    kind: "text" as const,
    status: "idle" as const,
  };
}

/**
 * THE FAILURE CARD FOR A DOCUMENT THAT NEVER FINISHED ARRIVING.
 *
 * On 2026-08-21 a `createTextDocument` call froze at `input-streaming` holding
 * 26,731 characters, and the UI rendered it as `DocumentToolCall` — the
 * "Creating …" row with a spinner. A spinner is a PROMISE that something is
 * still coming. Nothing was. The founder watched it, worked out for themselves
 * that the protocol stopped inside the INTENSITY rubric at score 3, and had to
 * report it; the 26KB had to be recovered by hand (Incident 6 in
 * docs/INCIDENTS.md).
 *
 * So a dead stream does not get a spinner and does not get a preview that looks
 * like a document. It gets this: the loss, its size, THE LINE IT STOPPED AFTER,
 * and one button that resumes from exactly there.
 */
function DeadDocumentStream({
  verdict,
  isReadonly,
  messageId,
}: {
  verdict: DeadStream;
  isReadonly: boolean;
  messageId: string;
}) {
  const { setArtifact } = useArtifact();
  const { sendMessage } = useChatActions<ChatMessage>();
  const storeApi = useChatStoreApi<ChatMessage>();
  const chatStatus = useChatStatus();
  const { salvage, store } = verdict;
  // This card stays on screen while a continuation is on its way (see
  // `AssistantMessage`), so a second press must not queue a second request.
  const isRequestInFlight =
    chatStatus === "submitted" || chatStatus === "streaming";

  // A STREAM THAT DIES WHILE THIS TAB WATCHES LEAVES THE PANEL SPINNING.
  //
  // The tool row auto-opened the panel and kept it at `status: "streaming"`
  // with the raw, unlabelled input. This card now owns the part, and the
  // part's own effect stops touching the panel once the part is dead, so
  // nothing else would ever stop that spinner or label the partial text. Only
  // a panel that is still streaming THIS message is settled: one the founder
  // has since pointed elsewhere is left alone, and a part that arrived already
  // dead (a reload) never owned the panel at all.
  useEffect(() => {
    setArtifact((prev) => {
      if (prev.messageId !== messageId || prev.status !== "streaming") {
        return prev;
      }
      return salvage.salvaged
        ? { ...prev, ...unsavedCopyFields(salvage) }
        : { ...prev, status: "idle", isVisible: false };
    });
  }, [messageId, salvage, setArtifact]);

  const openPartial = () => {
    if (!salvage.salvaged) {
      return;
    }
    if (store.state === "saved") {
      // The Document row the server wrote, under its own id and kind; the
      // panel loads its stored content (and any later edits) by that id.
      // Marked partial in the panel header as well as in the body: a founder
      // who opens this and reads to the end must not be able to mistake it for
      // a finished document at any point on the way.
      setArtifact((prev) => ({
        ...prev,
        documentId: store.documentId,
        kind: store.kind,
        title: partialDocumentTitle(salvage.title),
        content: partialDocumentBody(salvage),
        messageId,
        status: "idle",
        isVisible: true,
      }));
      return;
    }
    // Nothing was saved (or the server's answer has not arrived yet), so this
    // is a copy rebuilt from the message itself; the card's label and detail
    // say it is unsaved.
    setArtifact((prev) => ({
      ...prev,
      ...unsavedCopyFields(salvage),
      isVisible: true,
    }));
  };

  const resume = () => {
    if (!sendMessage) {
      toast.error("This chat is read-only, so it cannot be continued here.");
      return;
    }
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: verdict.continueRequest }],
      metadata: {
        selectedModel: config.ai.workflows.chat,
        createdAt: new Date(),
        parentMessageId: storeApi.getState().getLastMessageId(),
        activeStreamId: null,
      },
    });
  };

  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex flex-row items-start gap-3">
        <div className="mt-0.5 text-destructive">
          <AlertTriangle size={18} />
        </div>
        <div className="flex flex-col gap-1">
          <div className="font-medium text-sm">{verdict.headline}</div>
          <div className="text-muted-foreground text-sm">{verdict.detail}</div>
        </div>
      </div>

      <div className="flex flex-row flex-wrap gap-2">
        {salvage.salvaged && (
          <Button
            onClick={openPartial}
            size="sm"
            type="button"
            variant="outline"
          >
            <FileWarning size={14} />
            {store.state === "saved"
              ? "Open the saved partial document"
              : "Open the unsaved copy"}
          </Button>
        )}
        {!isReadonly && (
          <Button
            disabled={isRequestInFlight}
            onClick={resume}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlayCircle size={14} />
            Continue from where it stopped
          </Button>
        )}
      </div>
    </div>
  );
}

function PureDocumentTool({
  tool,
  isReadonly,
  messageId,
}: DocumentToolComponentProps) {
  const { setArtifact } = useArtifact();
  const kind = getToolKind(tool.type);
  const isEdit = isEditTool(tool.type);
  const isLastArtifact = useIsLastArtifact(tool.toolCallId);
  const status = useChatStatus();
  const metadata = useMessageMetadataById(messageId);

  const inputTitle = tool.input?.title ?? "";
  const inputContent = tool.input?.content ?? "";

  // WHETHER THIS PART'S STREAM IS OVER IS `hasInputStreamEnded`'s CALL (its
  // comment says why chat status and `activeStreamId` each lie alone, why only
  // the last message can be receiving a stream, and why an `error` status ends
  // it). Two incidents are written into that rule: pressing "Continue" on a
  // dead card turned it back into the "Creating…" row, and a stream the server
  // aborted left the row spinning beside "Something went wrong" until reload.
  const isLastMessage = useLastMessageId() === messageId;
  const streamEnded = hasInputStreamEnded({
    isLastMessage,
    chatStatus: status,
    activeStreamId: metadata.activeStreamId,
  });

  const verdict = describeInputStream({
    state: tool.state,
    streamEnded,
    input: tool.input,
    errorText: tool.state === "output-error" ? tool.errorText : null,
    // A turn that just died in this tab still carries its `activeStreamId`,
    // and its server side may still be marking the part, so a reload can
    // answer "was it saved". A part loaded from storage has no id and no
    // marker: the server finished with it long ago and recorded nothing.
    reloadMayAnswer: Boolean(metadata.activeStreamId),
  });

  // Sync streaming content to artifact panel
  useEffect(() => {
    // A DEAD STREAM MUST NOT LEAVE THE PANEL SPINNING. `status: "streaming"`
    // is what made the artifact panel indistinguishable from one still filling
    // up; the card below owns this part's presentation once the stream is
    // over, and settles a panel this part left streaming.
    if (verdict.died) {
      return;
    }

    if (tool.state === "input-streaming" || tool.state === "input-available") {
      setArtifact((prev) => ({
        ...prev,
        documentId: "init",
        title: inputTitle,
        content: inputContent,
        kind,
        messageId,
        status: "streaming",
        ...(prev.status !== "streaming" && { isVisible: true }),
      }));
    }

    if (tool.state === "output-available" && tool.output) {
      const output = tool.output;
      if (output.status === "success") {
        setArtifact((prev) => ({
          ...prev,
          documentId: output.documentId,
          status: "idle",
          date: output.date,
        }));
      }
    }
  }, [
    tool,
    messageId,
    kind,
    inputTitle,
    inputContent,
    setArtifact,
    verdict.died,
  ]);

  // Checked BEFORE the generic error branch: a dead input stream is also an
  // `output-error` once the server has marked it, and the generic branch would
  // reduce a recoverable 26KB document to a one-line red "Error:".
  if (verdict.died) {
    return (
      <DeadDocumentStream
        isReadonly={isReadonly}
        messageId={messageId}
        verdict={verdict}
      />
    );
  }

  if (tool.state === "output-error" || tool.output?.status === "error") {
    const output = tool.output;
    const error = output?.status === "error" ? output.error : tool.errorText;

    return (
      <div className="rounded border p-2 text-red-500">Error: {error}</div>
    );
  }

  if (
    tool.state === "input-streaming" ||
    tool.state === "input-available" ||
    (tool.state === "output-available" && tool.output)
  ) {
    return (
      <DocumentPreview
        input={{ title: inputTitle, kind, content: inputContent }}
        isLastArtifact={isLastArtifact}
        isReadonly={isReadonly}
        messageId={messageId}
        output={
          tool.output
            ? {
                documentId: tool.output.documentId,
                title: inputTitle,
                kind,
              }
            : undefined
        }
        type={isEdit ? "update" : "create"}
      />
    );
  }

  return null;
}

export const DocumentTool = memo(
  PureDocumentTool,
  (prevProps, nextProps) =>
    prevProps.tool.state === nextProps.tool.state &&
    prevProps.tool.input?.title === nextProps.tool.input?.title &&
    prevProps.tool.input?.content === nextProps.tool.input?.content &&
    prevProps.tool.output === nextProps.tool.output &&
    prevProps.tool.errorText === nextProps.tool.errorText &&
    prevProps.isReadonly === nextProps.isReadonly &&
    prevProps.messageId === nextProps.messageId
);
