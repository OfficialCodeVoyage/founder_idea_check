"use client";

import { AlertTriangle, FileWarning, PlayCircle } from "lucide-react";
import { memo, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useArtifact } from "@/hooks/use-artifact";
import type { ChatMessage } from "@/lib/ai/types";
import {
  describeInputStream,
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
import { useMessageMetadataById } from "@/lib/stores/hooks-base";
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
 * THE FAILURE CARD FOR A DOCUMENT THAT NEVER FINISHED ARRIVING.
 *
 * On 2026-08-21 a `createTextDocument` call froze at `input-streaming` holding
 * 26,731 characters, and the UI rendered it as `DocumentToolCall` — the
 * "Creating …" row with a spinner. A spinner is a PROMISE that something is
 * still coming. Nothing was. The founder watched it, worked out for themselves
 * that the protocol stopped inside the INTENSITY rubric at score 3, and had to
 * report it; the 26KB was recovered by hand into RECOVERED-phase1-protocol.md.
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
  const { salvage, store } = verdict;

  const openPartial = () => {
    if (!salvage.salvaged) {
      return;
    }
    // Marked partial in the panel header as well as in the body: a founder
    // who opens this and reads to the end must not be able to mistake it for
    // a finished document at any point on the way.
    const title = partialDocumentTitle(salvage.title);
    const content = partialDocumentBody(salvage);
    if (store.state === "saved") {
      // The Document row the server wrote, under its own id and kind; the
      // panel loads its stored content (and any later edits) by that id.
      setArtifact((prev) => ({
        ...prev,
        documentId: store.documentId,
        kind: store.kind,
        title,
        content,
        messageId,
        status: "idle",
        isVisible: true,
      }));
      return;
    }
    // Nothing was saved (or the server's answer has not arrived yet), so this
    // is a copy rebuilt from the message itself. The bannered body is
    // markdown, hence `text`; the card's label and detail say it is unsaved.
    setArtifact((prev) => ({
      ...prev,
      documentId: "init",
      title,
      content,
      kind: "text",
      status: "idle",
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
          <Button onClick={resume} size="sm" type="button" variant="outline">
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

  // TWO INDEPENDENT SIGNALS, BOTH REQUIRED, BECAUSE EITHER ALONE LIES.
  //
  // `status` is "ready" for a beat while a resumable stream is being
  // reattached on load, so status alone would flash "this died" over a
  // document that is about to keep arriving. `activeStreamId` is null on a
  // message whose stream is genuinely over, but it is also null on every
  // message in a read-only or shared view. Requiring both means a part is
  // called dead only when nothing is running AND this message is not waiting
  // on anything.
  const streamEnded =
    status !== "streaming" &&
    status !== "submitted" &&
    !metadata.activeStreamId;

  const verdict = describeInputStream({
    state: tool.state,
    streamEnded,
    input: tool.input,
    errorText: tool.state === "output-error" ? tool.errorText : null,
  });

  // Sync streaming content to artifact panel
  useEffect(() => {
    // A DEAD STREAM MUST NOT LEAVE THE PANEL SPINNING. `status: "streaming"`
    // is what made the artifact panel indistinguishable from one still filling
    // up; the card below owns this part's presentation once the stream is over.
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
