import { Copy, History, Pen, Redo2, Undo2 } from "lucide-react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Artifact } from "@/components/create-artifact";
import { DocumentSkeleton } from "@/components/document-skeleton";
import { copyArtifactToClipboard } from "@/lib/artifacts/copy-to-clipboard";
import { config } from "@/lib/config";

const DiffView = dynamic(
  () => import("@/components/diffview").then((m) => ({ default: m.DiffView })),
  {
    loading: () => <DocumentSkeleton artifactKind="text" />,
    ssr: false,
  }
);

const Editor = dynamic(
  () => import("@/components/text-editor").then((m) => ({ default: m.Editor })),
  {
    loading: () => <DocumentSkeleton artifactKind="text" />,
    ssr: false,
  }
);
export const textArtifact = new Artifact<"text">({
  kind: "text",
  description: "Useful for text content, like drafting essays and emails.",
  content: ({
    mode,
    status,
    content,
    isCurrentVersion,
    currentVersionIndex,
    onSaveContent,
    getDocumentContentById,
    isLoading,
    isReadonly,
  }) => {
    if (isLoading) {
      return <DocumentSkeleton artifactKind="text" />;
    }

    if (mode === "diff") {
      const oldContent = getDocumentContentById(currentVersionIndex - 1);
      const newContent = getDocumentContentById(currentVersionIndex);

      return (
        <div className="m-auto flex max-w-3xl flex-row px-4 py-8 md:p-20">
          <DiffView newContent={newContent} oldContent={oldContent} />
        </div>
      );
    }

    return (
      <div className="m-auto flex max-w-3xl flex-row px-4 py-8 md:p-20">
        <Editor
          content={content}
          currentVersionIndex={currentVersionIndex}
          isCurrentVersion={isCurrentVersion}
          isReadonly={isReadonly}
          onSaveContent={onSaveContent}
          status={status}
        />
      </div>
    );
  },
  actions: [
    {
      icon: <History size={18} />,
      description: "View changes",
      onClick: ({ handleVersionChange }) => {
        handleVersionChange("toggle");
      },
      isDisabled: ({ currentVersionIndex }) => {
        if (currentVersionIndex === 0) {
          return true;
        }

        return false;
      },
    },
    {
      icon: <Undo2 size={18} />,
      description: "View Previous version",
      onClick: ({ handleVersionChange }) => {
        handleVersionChange("prev");
      },
      isDisabled: ({ currentVersionIndex }) => {
        if (currentVersionIndex === 0) {
          return true;
        }

        return false;
      },
    },
    {
      icon: <Redo2 size={18} />,
      description: "View Next version",
      onClick: ({ handleVersionChange }) => {
        handleVersionChange("next");
      },
      isDisabled: ({ isCurrentVersion }) => {
        if (isCurrentVersion) {
          return true;
        }

        return false;
      },
    },
    {
      icon: <Copy size={18} />,
      description: "Copy to clipboard",
      // GUARD, AWAIT, THEN REPORT WHAT HAPPENED. This used to fire
      // `toast.success` unconditionally over an unawaited, uncaught promise,
      // with no empty check — so a founder whose document stream had died was
      // told "Copied to clipboard!" and got nothing. See
      // lib/artifacts/copy-to-clipboard.ts for the full incident.
      onClick: async ({ content }) => {
        const outcome = await copyArtifactToClipboard({
          content,
          what: "text",
        });
        if (outcome.copied) {
          toast.success("Copied to clipboard!");
          return;
        }
        toast.error(outcome.why);
      },
    },
  ],
  toolbar: [
    {
      icon: <Pen size={16} />,
      description: "Add final polish",
      onClick: ({ sendMessage, storeApi }) => {
        sendMessage({
          role: "user",
          parts: [
            {
              type: "text",
              text: "Please add final polish and check for grammar, add section titles for better structure, and ensure everything reads smoothly.",
            },
          ],
          metadata: {
            selectedModel: config.ai.tools.text.polish,
            createdAt: new Date(),
            parentMessageId: storeApi.getState().getLastMessageId(),
            activeStreamId: null,
          },
        });
      },
    },
  ],
});
