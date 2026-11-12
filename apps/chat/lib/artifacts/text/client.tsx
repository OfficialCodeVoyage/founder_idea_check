import { Copy, History, Pen, Redo2, Undo2 } from "lucide-react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Artifact } from "@/components/create-artifact";
import { DocumentSkeleton } from "@/components/document-skeleton";
import { copyArtifactToClipboard } from "@/lib/artifacts/copy-to-clipboard";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";

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

/**
 * THE PAGE MEASURES THE PANEL, NOT THE WINDOW.
 *
 * The side panel is about 360px wide in a 1280px window, and the page's
 * padding used to key off the window (`md:p-20`): 160px of it, leaving a column
 * about 200px wide with a 36px title (prose's `h1`) set in it, one or two words
 * to a line. The wrapper below is a container, so the padding and the title
 * size follow the panel's own width instead. From 768px up the padding is the
 * 80px it always was, and the title is the 36px prose gives an `h1` from about
 * 600px up, so a panel at full width looks as before. Below that the title
 * shrinks smoothly to a floor of 24px and the padding drops to the 16px a
 * phone already used.
 *
 * `cqi` is 1% of the nearest container's inline size, so the title clamp reads
 * this wrapper. The title selector is scoped to this wrapper on purpose: the
 * same editor renders inline in the chat (`DocumentPreview`), where nothing
 * about the panel's width applies.
 */
const PAGE_CONTAINER_CLASS = "@container flex w-full flex-col items-center";
const PAGE_CLASS = "m-auto flex max-w-3xl flex-row px-4 py-8 @3xl:p-20";
const TITLE_SIZE_CLASS = "[&_h1]:text-[length:clamp(1.5rem,6cqi,2.25rem)]";

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
        <div className={PAGE_CONTAINER_CLASS}>
          <div className={PAGE_CLASS}>
            <DiffView newContent={newContent} oldContent={oldContent} />
          </div>
        </div>
      );
    }

    return (
      <div className={PAGE_CONTAINER_CLASS}>
        <div className={cn(PAGE_CLASS, TITLE_SIZE_CLASS)}>
          <Editor
            content={content}
            currentVersionIndex={currentVersionIndex}
            isCurrentVersion={isCurrentVersion}
            isReadonly={isReadonly}
            onSaveContent={onSaveContent}
            status={status}
          />
        </div>
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
