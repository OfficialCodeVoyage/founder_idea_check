"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { useMutation } from "@tanstack/react-query";
import { CameraIcon, FileIcon, ImageIcon, PlusIcon, XIcon } from "lucide-react";
import type React from "react";
import {
  type ChangeEvent,
  type Dispatch,
  memo,
  type SetStateAction,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ContextBar } from "@/components/context-bar";
import { ContextUsageFromParent } from "@/components/context-usage";
import { usePhaseKey } from "@/components/phase/phase-gate-provider";
import { useArtifact } from "@/hooks/use-artifact";
import { useIsMobile } from "@/hooks/use-mobile";
import type { AppModelId } from "@/lib/ai/app-model-id";
import {
  type Attachment,
  type ChatMessage,
  expandSelectedModelValue,
  type SelectedModelValue,
  type UiToolName,
} from "@/lib/ai/types";
import { config } from "@/lib/config";
import {
  buildDraftChatSubmission,
  normalizeSelectedModel,
} from "@/lib/draft-chat-submission";
import { processFilesForUpload } from "@/lib/files/upload-prep";
import { humanizeCriterionId } from "@/lib/phases/rail";
import {
  useSendDraftChatSubmission,
  useSendFlight,
} from "@/lib/send-draft-chat-submission";
import { useChatActions, useChatStoreApi } from "@/lib/stores/base";
import { useLastMessageId } from "@/lib/stores/hooks-base";
import { ANONYMOUS_LIMITS } from "@/lib/types/anonymous";
import { cn } from "@/lib/utils";
import {
  type CriterionTarget,
  useChatInput,
} from "@/providers/chat-input-provider";
import { useChatModels } from "@/providers/chat-models-provider";
import { useSession } from "@/providers/session-provider";
import { useTRPC } from "@/trpc/react";
import { ConnectorsDropdown } from "./connectors-dropdown";
import { LexicalChatInput } from "./lexical-chat-input";
import { ModelSelector } from "./model-selector";
import { ResponsiveTools } from "./responsive-tools";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { LimitDisplay } from "./upgrade-cta/limit-display";
import { LoginPrompt } from "./upgrade-cta/login-prompt";

/** Derive accept string for images only */
function getAcceptImages(acceptedTypes: Record<string, string[]>): string {
  return Object.entries(acceptedTypes)
    .filter(([mime]) => mime.startsWith("image/"))
    .flatMap(([, exts]) => exts)
    .join(",");
}

/** Derive accept string for non-image files only */
function getAcceptFiles(acceptedTypes: Record<string, string[]>): string {
  return Object.entries(acceptedTypes)
    .filter(([mime]) => !mime.startsWith("image/"))
    .flatMap(([, exts]) => exts)
    .join(",");
}

/** Derive accept string for all file types */
function getAcceptAll(acceptedTypes: Record<string, string[]>): string {
  return Object.values(acceptedTypes).flat().join(",");
}

function PureMultimodalInput({
  chatId,
  status,
  className,
  autoFocus = false,
  isEditMode = false,
  isActive = true,
  parentMessageId,
  onSendMessage,
}: {
  chatId: string;
  status: UseChatHelpers<ChatMessage>["status"];
  className?: string;
  autoFocus?: boolean;
  isEditMode?: boolean;
  /**
   * FALSE FOR A COMPOSER THAT IS MOUNTED BUT NOT THE ONE THE FOUNDER IS USING.
   *
   * `ChatContent` keeps BOTH `ChatWelcome` and `MessagesPane` mounted on
   * non-project routes and toggles them with a `hidden` class, so two composers
   * exist at once. Both claimed `data-testid="multimodal-input"` and
   * `data-testid="model-selector"` (2 of each, confirmed by
   * `querySelectorAll`), and — worse than the duplicate ids — both bound the
   * SINGLE shared `editorRef` from `ChatInputProvider`, so the last one
   * committed owned it: `clearInput()` on the welcome screen cleared the HIDDEN
   * editor. The inactive composer now claims no testid, does not take the ref,
   * and does not autofocus.
   */
  isActive?: boolean;
  parentMessageId: string | null;
  onSendMessage?: (message: ChatMessage) => void | Promise<void>;
}) {
  const storeApi = useChatStoreApi<ChatMessage>();
  const { artifact, closeArtifact } = useArtifact();
  const { data: session } = useSession();
  const trpc = useTRPC();
  const isMobile = useIsMobile();
  const sendDraftChatSubmission = useSendDraftChatSubmission(chatId);
  const { isInFlight: isSendInFlight } = useSendFlight(chatId);
  const { setMessages, stop: stopHelper } = useChatActions<ChatMessage>();
  const lastMessageId = useLastMessageId();
  const {
    editorRef,
    selectedTool,
    setSelectedTool,
    attachments,
    setAttachments,
    selectedModelId,
    selectedModelSelection,
    handleModelChange,
    handleModelSelectionChange,
    getInputValue,
    handleInputChange,
    getInitialInput,
    isEmpty,
    handleSubmit,
    criterionTarget: storedCriterionTarget,
    setCriterionTarget,
  } = useChatInput();

  // A TARGET DOES NOT OUTLIVE ITS PHASE, and that is derived where it is read
  // rather than cleared by an effect. The gate advances in `after()`, so a
  // founder can have "Answer" armed on a criterion of phase 3 when phase 4
  // opens; sending the old id then would label an answer with a criterion the
  // new phase does not have. Read through this, a target from another phase (or
  // with no gate to say which phase this is) is simply not there: no chip, no
  // hint, no label. The stale value in the provider is overwritten by the next
  // "Answer" and cleared by the next send.
  //
  // `usePhaseKey`, not `usePhaseGate`: this composer is memoised, and the whole
  // gate payload changes on every poll while a verdict is awaited. The phase
  // key is a string in a context of its own, so only a change of phase renders.
  const gatePhaseKey = usePhaseKey();
  const criterionTarget =
    storedCriterionTarget && storedCriterionTarget.phaseKey === gatePhaseKey
      ? storedCriterionTarget
      : null;

  const isAnonymous = !session?.user;
  const isModelDisallowedForAnonymous =
    isAnonymous &&
    !(ANONYMOUS_LIMITS.AVAILABLE_MODELS as readonly AppModelId[]).includes(
      selectedModelId
    );
  const { getModelById } = useChatModels();
  const stopStreamMutation = useMutation(
    trpc.chat.stopStream.mutationOptions()
  );
  const normalizedSelectedModel = useMemo<SelectedModelValue>(
    () => normalizeSelectedModel({ selectedModelId, selectedModelSelection }),
    [selectedModelId, selectedModelSelection]
  );
  const requestedModelIds = useMemo(
    () => expandSelectedModelValue(normalizedSelectedModel),
    [normalizedSelectedModel]
  );
  const parallelResponsesEnabled = config.features.parallelResponses;
  const isParallelModelRequest =
    parallelResponsesEnabled && requestedModelIds.length > 1;

  // Attachment configuration from site config
  const { maxBytes, maxDimension, acceptedTypes } = config.attachments;
  const maxMB = Math.round(maxBytes / (1024 * 1024));
  const attachmentsEnabled = config.features.attachments;
  const acceptImages = useMemo(
    () => getAcceptImages(acceptedTypes),
    [acceptedTypes]
  );
  const acceptFiles = useMemo(
    () => getAcceptFiles(acceptedTypes),
    [acceptedTypes]
  );
  const acceptAll = useMemo(() => getAcceptAll(acceptedTypes), [acceptedTypes]);

  // Helper function to auto-switch to PDF-compatible model
  const switchToPdfCompatibleModel = useCallback(() => {
    const pdfModel = config.ai.workflows.pdf;
    const defaultPdfModelDef = getModelById(pdfModel);
    if (defaultPdfModelDef) {
      toast.success(`Switched to ${defaultPdfModelDef.name} (supports PDF)`);
    }
    handleModelChange(pdfModel);
    return defaultPdfModelDef;
  }, [handleModelChange, getModelById]);

  // Helper function to auto-switch to image-compatible model
  const switchToImageCompatibleModel = useCallback(() => {
    const imageModel = config.ai.workflows.chatImageCompatible;
    const defaultImageModelDef = getModelById(imageModel);
    if (defaultImageModelDef) {
      toast.success(
        `Switched to ${defaultImageModelDef.name} (supports images)`
      );
    }
    handleModelChange(imageModel);
    return defaultImageModelDef;
  }, [handleModelChange, getModelById]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<string[]>([]);

  // Centralized submission gating
  const submission = useMemo(():
    | { enabled: false; message: string }
    | { enabled: true } => {
    if (isParallelModelRequest && !session?.user) {
      return {
        enabled: false,
        message: "Log in to use multiple models",
      };
    }
    if (isParallelModelRequest && attachments.length > 0) {
      return {
        enabled: false,
        message: "Multiple models with attachments are not supported yet",
      };
    }
    if (isModelDisallowedForAnonymous) {
      return { enabled: false, message: "Log in to use this model" };
    }
    if (status !== "ready" && status !== "error") {
      return {
        enabled: false,
        message: "Please wait for the model to finish its response!",
      };
    }
    if (uploadQueue.length > 0) {
      return {
        enabled: false,
        message: "Please wait for files to finish uploading!",
      };
    }
    if (isEmpty) {
      return {
        enabled: false,
        message: "Please enter a message before sending!",
      };
    }
    return { enabled: true };
  }, [
    attachments.length,
    isEmpty,
    isModelDisallowedForAnonymous,
    isParallelModelRequest,
    session?.user,
    status,
    uploadQueue.length,
  ]);

  // Helper function to process and validate files
  const processFiles = useCallback(
    async (files: File[]): Promise<File[]> => {
      const { processedImages, pdfFiles, stillOversized, unsupportedFiles } =
        await processFilesForUpload(files, { maxBytes, maxDimension });

      if (stillOversized.length > 0) {
        toast.error(
          `${stillOversized.length} file(s) exceed ${maxMB}MB after compression`
        );
      }
      if (unsupportedFiles.length > 0) {
        toast.error(
          `${unsupportedFiles.length} unsupported file type(s). Only images and PDFs are allowed`
        );
      }

      // Auto-switch model based on file types
      if (pdfFiles.length > 0 || processedImages.length > 0) {
        let currentModelDef = getModelById(selectedModelId);

        if (pdfFiles.length > 0 && !currentModelDef?.input?.pdf) {
          currentModelDef = switchToPdfCompatibleModel();
        }
        if (processedImages.length > 0 && !currentModelDef?.input?.image) {
          currentModelDef = switchToImageCompatibleModel();
        }
      }

      return [...processedImages, ...pdfFiles];
    },
    [
      maxBytes,
      maxDimension,
      maxMB,
      selectedModelId,
      switchToPdfCompatibleModel,
      switchToImageCompatibleModel,
      getModelById,
    ]
  );

  // Trim messages in edit mode
  const trimMessagesInEditMode = useCallback(
    (parentId: string | null) => {
      if (parentId === null) {
        setMessages([]);
        // Close artifact if it was visible since all messages are removed
        if (artifact.isVisible) {
          closeArtifact();
        }
        return;
      }

      const parentIndex = storeApi
        .getState()
        .getThrottledMessages()
        .findIndex((msg: ChatMessage) => msg.id === parentId);

      if (parentIndex !== -1) {
        const messagesUpToParent = storeApi
          .getState()
          .getThrottledMessages()
          .slice(0, parentIndex + 1);

        // Close artifact if its message will not be in the trimmed messages
        if (
          artifact.isVisible &&
          artifact.messageId &&
          !messagesUpToParent.some((m) => m.id === artifact.messageId)
        ) {
          closeArtifact();
        }

        setMessages(messagesUpToParent);
      }
    },
    [
      artifact.isVisible,
      artifact.messageId,
      closeArtifact,
      setMessages,
      storeApi,
    ]
  );

  const coreSubmitLogic = useCallback(() => {
    const input = getInputValue();

    // Get the appropriate parent message ID
    const effectiveParentMessageId = isEditMode
      ? parentMessageId
      : lastMessageId;

    // In edit mode, trim messages to the parent message
    if (isEditMode) {
      trimMessagesInEditMode(parentMessageId);
    }

    const { message, requestSpecs } = buildDraftChatSubmission({
      attachments,
      input,
      normalizedSelectedModel,
      parallelResponsesEnabled,
      parentMessageId: effectiveParentMessageId,
      selectedTool,
      // A label on the message, never a prefix on its text: `input` above is
      // sent exactly as typed.
      targetCriterionId: criterionTarget?.criterionId,
    });

    onSendMessage?.(message);

    const startedProvisionalChat = sendDraftChatSubmission({
      message,
      onStarted: () => {
        if (!isMobile) {
          editorRef.current?.focus();
        }
      },
      requestSpecs,
    });

    // CLEARED ONLY AFTER THE SEND, never before it: the label has to be on the
    // message when it leaves. `sendDraftChatSubmission` has called
    // `sendMessage` by the time it returns, on the provisional-chat path too.
    setCriterionTarget(null);

    // A provisional chat refocuses through `onStarted`.
    if (startedProvisionalChat) {
      return;
    }

    // Refocus after submit
    if (!isMobile) {
      editorRef.current?.focus();
    }
  }, [
    attachments,
    criterionTarget?.criterionId,
    isMobile,
    editorRef,
    getInputValue,
    isEditMode,
    lastMessageId,
    normalizedSelectedModel,
    onSendMessage,
    parentMessageId,
    parallelResponsesEnabled,
    selectedTool,
    sendDraftChatSubmission,
    setCriterionTarget,
    trimMessagesInEditMode,
  ]);

  // The "Stop answering" button that was just pressed unmounts with the chip, so
  // focus goes where the founder is about to type, not to the document body.
  // Not on mobile, like every other refocus in this composer: it would raise
  // the keyboard for a tap that only dismissed a label.
  const clearCriterionTarget = useCallback(() => {
    setCriterionTarget(null);
    if (!isMobile) {
      editorRef.current?.focus();
    }
  }, [editorRef, isMobile, setCriterionTarget]);

  const submitForm = useCallback(() => {
    // EVERY WAY OF SENDING (Enter, the form, the send button) COMES THROUGH
    // HERE, so this is the one place a send another sender has just made is
    // seen before the chat status shows it: `submission` above reads a
    // render-time status, which stays `ready` for a frame or two after the gate
    // card's "Plan how to find out" sends. Refusing here, before `handleSubmit`,
    // keeps what the founder typed in the editor. The message says what is
    // happening (a send is under way), not that the model is answering: in this
    // window nothing visibly is.
    if (isSendInFlight()) {
      toast.error(
        "Your last message is still being sent. Wait for the reply, or press Stop to cancel it."
      );
      return;
    }
    handleSubmit(coreSubmitLogic, isEditMode);
  }, [isSendInFlight, handleSubmit, coreSubmitLogic, isEditMode]);

  const uploadFile = useCallback(
    async (
      file: File
    ): Promise<
      { url: string; name: string; contentType: string } | undefined
    > => {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const response = await fetch("/api/files/upload", {
          method: "POST",
          body: formData,
        });

        if (response.ok) {
          const data: { url: string; pathname: string; contentType: string } =
            await response.json();
          const { url, pathname, contentType } = data;

          return {
            url,
            name: pathname,
            contentType,
          };
        }
        const { error } = (await response.json()) as { error?: string };
        toast.error(error);
      } catch (_error) {
        toast.error("Failed to upload file, please try again!");
      }
    },
    []
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      const validFiles = await processFiles(files);

      if (validFiles.length === 0) {
        return;
      }

      setUploadQueue(validFiles.map((file) => file.name));

      try {
        const uploadPromises = validFiles.map((file) => uploadFile(file));
        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) => attachment !== undefined
        );

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...successfullyUploadedAttachments,
        ]);
      } catch (error) {
        console.error("Error uploading files!", error);
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, processFiles, uploadFile]
  );

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent) => {
      if (status !== "ready") {
        return;
      }

      // Skip file paste handling if blob storage is disabled
      if (!attachmentsEnabled) {
        return;
      }

      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        return;
      }

      const files = Array.from(clipboardData.files);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();

      // Check if user is anonymous
      if (!session?.user) {
        toast.error("Sign in to attach files from clipboard");
        return;
      }

      const validFiles = await processFiles(files);
      if (validFiles.length === 0) {
        return;
      }

      setUploadQueue(validFiles.map((file) => file.name));

      try {
        const uploadPromises = validFiles.map((file) => uploadFile(file));
        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) => attachment !== undefined
        );

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...successfullyUploadedAttachments,
        ]);

        toast.success(
          `${successfullyUploadedAttachments.length} file(s) pasted from clipboard`
        );
      } catch (error) {
        console.error("Error uploading pasted files!", error);
      } finally {
        setUploadQueue([]);
      }
    },
    [
      setAttachments,
      processFiles,
      status,
      session,
      uploadFile,
      attachmentsEnabled,
    ]
  );

  const removeAttachment = useCallback(
    (attachmentToRemove: Attachment) => {
      setAttachments((currentAttachments) =>
        currentAttachments.filter(
          (attachment) => attachment.url !== attachmentToRemove.url
        )
      );
    },
    [setAttachments]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: async (acceptedFiles) => {
      if (acceptedFiles.length === 0) {
        return;
      }

      // Check if user is anonymous
      if (!session?.user) {
        toast.error("Sign in to attach files");
        return;
      }

      const validFiles = await processFiles(acceptedFiles);
      if (validFiles.length === 0) {
        return;
      }

      setUploadQueue(validFiles.map((file) => file.name));

      try {
        const uploadPromises = validFiles.map((file) => uploadFile(file));
        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) => attachment !== undefined
        );

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...successfullyUploadedAttachments,
        ]);
      } catch (error) {
        console.error("Error uploading files!", error);
      } finally {
        setUploadQueue([]);
      }
    },
    noClick: true, // Prevent click to open file dialog since we have the button
    disabled: status !== "ready" || !attachmentsEnabled,
    noDrag: !attachmentsEnabled,
    accept: acceptedTypes,
  });

  const handleStop = useCallback(() => {
    if (session?.user && lastMessageId) {
      stopStreamMutation.mutate({ messageId: lastMessageId });
    }
    stopHelper?.();
  }, [lastMessageId, session?.user, stopHelper, stopStreamMutation]);

  // `undefined` REMOVES the attribute rather than renaming it: the inactive
  // composer must not be findable by a testid at all, or a scoped locator would
  // still have two nodes to choose between. `MessageEditor` mounts a third
  // composer with isEditMode, which keeps its own suffixed pair so a message
  // being edited and the chat composer never collide.
  const surfaceSuffix = isEditMode ? "-editor" : "";
  const composerTestId = isActive
    ? `multimodal-input${surfaceSuffix}`
    : undefined;
  // On mobile Enter is a newline and Ctrl+Enter sends, so the hint stays on
  // every placeholder there, the armed target's included.
  const mobileSendHint = isMobile ? " (Ctrl+Enter to send)" : "";
  const defaultPlaceholder = `Send a message...${mobileSendHint}`;
  const modelSelectorTestId = isActive
    ? `model-selector${surfaceSuffix}`
    : undefined;

  return (
    <div className="relative">
      {attachmentsEnabled && (
        <input
          accept={acceptAll}
          className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
          multiple
          onChange={handleFileChange}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
      )}

      {/*
        `inert` ALONE, NOT `aria-hidden` TOO. `inert` already removes the
        subtree from the accessibility tree, from tab order and from clicks, and
        the pane that owns an inactive composer is `hidden` (display: none) as
        well. The welcome composer goes inactive on the first send while its
        editor still holds focus, and the browser logs "Blocked aria-hidden on
        an element because its descendant retained focus" for an `aria-hidden`
        ancestor of the focused element, once per first send.
      */}
      <div className="relative" inert={!isActive}>
        <PromptInput
          className={cn(
            "@container relative transition-colors",
            isDragActive && "border-primary bg-accent",
            className
          )}
          inputGroupClassName="bg-muted dark:bg-muted"
          {...getRootProps({ onError: undefined, onSubmit: undefined })}
          onSubmit={(_message, event) => {
            event.preventDefault();
            if (!submission.enabled) {
              if (submission.message) {
                toast.error(submission.message);
              }
              return;
            }
            submitForm();
          }}
        >
          <input {...getInputProps()} />

          {isDragActive && attachmentsEnabled && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-primary border-dashed bg-accent/80">
              <div className="font-medium text-primary">
                Drop images or PDFs here to attach
              </div>
            </div>
          )}

          {!isEditMode && (
            <LimitDisplay
              className="p-2"
              forceVariant={isModelDisallowedForAnonymous ? "model" : "credits"}
            />
          )}

          <ContextBar
            attachments={attachments}
            chatId={chatId}
            className="w-full"
            onRemoveAction={removeAttachment}
            uploadQueue={uploadQueue}
          />

          {isActive && !isEditMode ? (
            <CriterionTargetBar
              onClear={clearCriterionTarget}
              target={criterionTarget}
            />
          ) : null}

          <LexicalChatInput
            autoFocus={autoFocus && isActive}
            className="max-h-[max(35svh,5rem)] min-h-[60px] overflow-y-scroll sm:min-h-[80px]"
            data-testid={composerTestId}
            initialValue={getInitialInput()}
            onEnterSubmit={(event) => {
              const shouldSubmit = isMobile ? event.ctrlKey : !event.shiftKey;

              if (shouldSubmit) {
                if (!submission.enabled) {
                  if (submission.message) {
                    toast.error(submission.message);
                  }
                  return true;
                }
                submitForm();
                return true;
              }

              return false;
            }}
            onInputChange={handleInputChange}
            onPaste={handlePaste}
            placeholder={
              criterionTarget
                ? `${TARGET_HINT[criterionTarget.closure]}${mobileSendHint}`
                : defaultPlaceholder
            }
            ref={isActive ? editorRef : undefined}
          />

          <ChatInputBottomControls
            acceptAll={acceptAll}
            acceptFiles={acceptFiles}
            acceptImages={acceptImages}
            attachmentsEnabled={attachmentsEnabled}
            fileInputRef={fileInputRef}
            modelSelectorTestId={modelSelectorTestId}
            onModelSelectionChange={handleModelSelectionChange}
            onStop={handleStop}
            parentMessageId={parentMessageId}
            selectedModelId={selectedModelId}
            selectedModelSelection={selectedModelSelection}
            selectedTool={selectedTool}
            setSelectedTool={setSelectedTool}
            status={status}
            submission={submission}
            submitForm={submitForm}
          />
        </PromptInput>
      </div>
    </div>
  );
}

function PureAttachmentsButton({
  fileInputRef,
  status,
  acceptAll,
  acceptImages,
  acceptFiles,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  status: UseChatHelpers<ChatMessage>["status"];
  acceptAll: string;
  acceptImages: string;
  acceptFiles: string;
}) {
  const { data: session } = useSession();
  const isMobile = useIsMobile();
  const isAnonymous = !session?.user;
  const [showLoginPopover, setShowLoginPopover] = useState(false);

  const triggerFileInput = useCallback(
    (accept: string, capture?: "environment" | "user") => {
      const input = fileInputRef.current;
      if (!input) {
        return;
      }
      input.accept = accept;
      if (capture) {
        input.capture = capture;
      } else {
        input.removeAttribute("capture");
      }
      input.click();
    },
    [fileInputRef]
  );

  const handleDesktopClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (isAnonymous) {
      setShowLoginPopover(true);
      return;
    }
    triggerFileInput(acceptAll);
  };

  // Mobile: dropdown with separate options
  if (isMobile) {
    if (isAnonymous) {
      return (
        <Popover onOpenChange={setShowLoginPopover} open={showLoginPopover}>
          <PopoverTrigger asChild>
            <PromptInputButton
              className="size-8"
              data-testid="attachments-button"
              disabled={status !== "ready"}
              onClick={() => setShowLoginPopover(true)}
              variant="ghost"
            >
              <PlusIcon className="size-4" />
            </PromptInputButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-0">
            <LoginPrompt
              description="You can attach images and PDFs to your messages for the AI to analyze."
              title="Sign in to attach files"
            />
          </PopoverContent>
        </Popover>
      );
    }

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <PromptInputButton
            className="size-8"
            data-testid="attachments-button"
            disabled={status !== "ready"}
            variant="ghost"
          >
            <PlusIcon className="size-4" />
          </PromptInputButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => triggerFileInput(acceptImages)}>
            <ImageIcon />
            Add photos
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => triggerFileInput(acceptImages, "environment")}
          >
            <CameraIcon />
            Take photo
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => triggerFileInput(acceptFiles)}>
            <FileIcon />
            Add files
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Desktop: single button with tooltip
  return (
    <Popover onOpenChange={setShowLoginPopover} open={showLoginPopover}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <PromptInputButton
              className="@[500px]:size-10 size-8"
              data-testid="attachments-button"
              disabled={status !== "ready"}
              onClick={handleDesktopClick}
              variant="ghost"
            >
              <PlusIcon className="size-4" />
            </PromptInputButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Add Files</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-0">
        <LoginPrompt
          description="You can attach images and PDFs to your messages for the AI to analyze."
          title="Sign in to attach files"
        />
      </PopoverContent>
    </Popover>
  );
}

const AttachmentsButton = memo(PureAttachmentsButton);

/**
 * WHAT THE FOUNDER IS ANSWERING, in the founder's words, above the editor.
 *
 * The gate card's "Answer" sets a target; this is where it stays visible until
 * the message is sent or it is dismissed. It is a label OUTSIDE the editor on
 * purpose: nothing here is ever put in the message text, so what the gate judges
 * and what extraction quotes is exactly what the founder typed.
 *
 * Not a `PromptInputHeader`: that addon focuses the form's `<input>` on click
 * and carries a border and a background built for the attachment strip.
 */
function CriterionTargetChip({
  title,
  onClear,
}: {
  title: string;
  onClear: () => void;
}) {
  return (
    <div
      className="flex w-full min-w-0 items-center px-3 pt-2"
      data-testid="criterion-target-chip"
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-background py-0.5 pr-0.5 pl-2.5 text-xs">
        <span className="min-w-0 truncate">
          <span className="text-foreground/75">Answering:</span>{" "}
          <span className="font-medium">{title}</span>
        </span>
        <button
          aria-label={`Stop answering ${title}`}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full text-foreground/75 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClear}
          type="button"
        >
          <XIcon aria-hidden="true" className="size-3" />
        </button>
      </span>
    </div>
  );
}

/** What the empty editor says while a criterion is the target. */
const TARGET_HINT = {
  "in-conversation": "Say it in a full sentence, in your own words.",
  "offline-only":
    "What did you find? Who you spoke to, how many, when, and what they said.",
} as const;

/**
 * THE TARGET, SEEN AND HEARD.
 *
 * The chip is only visible, and a control that appears is not announced, so a
 * screen-reader user who pressed "Answer" would be told nothing. The region is
 * mounted all the time and only its text changes, which is what a polite live
 * region announces reliably. It carries the hint too, since the placeholder that
 * shows it is not read as a label. Empty (so silent) when there is no target.
 */
function CriterionTargetBar({
  onClear,
  target,
}: {
  onClear: () => void;
  target: CriterionTarget | null;
}) {
  const title = target ? humanizeCriterionId(target.criterionId) : null;
  return (
    <>
      <output className="sr-only">
        {target && title
          ? `Answering ${title}. ${TARGET_HINT[target.closure]}`
          : ""}
      </output>
      {title ? <CriterionTargetChip onClear={onClear} title={title} /> : null}
    </>
  );
}

function PureChatInputBottomControls({
  selectedModelId,
  selectedModelSelection,
  onModelSelectionChange,
  selectedTool,
  setSelectedTool,
  fileInputRef,
  status,
  submitForm,
  submission,
  parentMessageId,
  acceptAll,
  acceptImages,
  acceptFiles,
  attachmentsEnabled,
  modelSelectorTestId,
  onStop,
}: {
  selectedModelId: AppModelId;
  selectedModelSelection: SelectedModelValue;
  onModelSelectionChange: (selection: SelectedModelValue) => void;
  selectedTool: UiToolName | null;
  setSelectedTool: Dispatch<SetStateAction<UiToolName | null>>;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  status: UseChatHelpers<ChatMessage>["status"];
  submitForm: () => void;
  submission: { enabled: boolean; message?: string };
  parentMessageId: string | null;
  acceptAll: string;
  acceptImages: string;
  acceptFiles: string;
  attachmentsEnabled: boolean;
  /** Undefined on the inactive composer, so only one selector carries the id. */
  modelSelectorTestId?: string;
  onStop: () => void;
}) {
  return (
    <PromptInputFooter className="flex w-full min-w-0 flex-row items-center justify-between @[500px]:gap-2 gap-1 border-t px-1 py-1 group-has-[>input]/input-group:pb-1 [.border-t]:pt-1">
      <PromptInputTools className="flex min-w-0 items-center @[500px]:gap-2 gap-1">
        {attachmentsEnabled && (
          <AttachmentsButton
            acceptAll={acceptAll}
            acceptFiles={acceptFiles}
            acceptImages={acceptImages}
            fileInputRef={fileInputRef}
            status={status}
          />
        )}
        <ModelSelector
          className="@[500px]:h-10 h-8 w-fit max-w-none shrink justify-start truncate @[500px]:px-3 px-2 @[500px]:text-sm text-xs"
          onModelSelectionChangeAction={onModelSelectionChange}
          selectedModelId={selectedModelId}
          selectedModelSelection={selectedModelSelection}
          testId={modelSelectorTestId}
        />
        <ConnectorsDropdown />
        <ResponsiveTools
          selectedModelId={selectedModelId}
          setTools={setSelectedTool}
          tools={selectedTool}
        />
      </PromptInputTools>
      <div className="flex items-center gap-1">
        <ContextUsageFromParent
          className="@[500px]:block hidden"
          iconOnly
          parentMessageId={parentMessageId}
          selectedModelId={selectedModelId}
        />
        <PromptInputSubmit
          className={"@[500px]:size-10 size-8 shrink-0"}
          disabled={status === "ready" && !submission.enabled}
          onClick={(e) => {
            e.preventDefault();
            if (status === "streaming" || status === "submitted") {
              onStop();
            } else if (status === "ready" || status === "error") {
              if (!submission.enabled) {
                if (submission.message) {
                  toast.error(submission.message);
                }
                return;
              }
              submitForm();
            }
          }}
          status={status}
        />
      </div>
    </PromptInputFooter>
  );
}

const ChatInputBottomControls = memo(PureChatInputBottomControls);

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.status !== nextProps.status) {
      return false;
    }
    if (prevProps.autoFocus !== nextProps.autoFocus) {
      return false;
    }
    if (prevProps.isEditMode !== nextProps.isEditMode) {
      return false;
    }
    // LOAD-BEARING. Without it the flag cannot cross this memo, and the pane
    // that goes inactive on the first message keeps the testid AND keeps
    // `editorRef` — except `useImperativeHandle(ref, create, [editor])` compiles
    // to deps `[editor, ref]`, so the pane that DOES re-render detaches the ref
    // and nothing reattaches it: `clearInput()` and `focus()` in
    // `ChatInputProvider` become silent no-ops.
    if (prevProps.isActive !== nextProps.isActive) {
      return false;
    }
    if (prevProps.chatId !== nextProps.chatId) {
      return false;
    }
    if (prevProps.className !== nextProps.className) {
      return false;
    }
    if (prevProps.parentMessageId !== nextProps.parentMessageId) {
      return false;
    }
    if (prevProps.onSendMessage !== nextProps.onSendMessage) {
      return false;
    }
    return true;
  }
);
