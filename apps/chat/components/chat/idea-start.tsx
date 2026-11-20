"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { InternalLink } from "@/components/internal-link";
import { SuggestedActions } from "@/components/suggested-actions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/hooks/use-mobile";
import { PHASES } from "@/lib/phases/definitions";
import { cn } from "@/lib/utils";
import { useSession } from "@/providers/session-provider";
import { useStartIdeaTest } from "./use-start-idea-test";

const FIRST_PHASE = PHASES[0];

/**
 * Where the test starts and how long it is: eight marks, the first one lit.
 * The marks are the real phase count, not decoration, and the text says the
 * same thing for anyone who cannot see them.
 */
function PhaseTrack() {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div aria-hidden className="flex shrink-0 items-center gap-1">
        {PHASES.map((phase) => (
          <span
            className={cn(
              "h-1.5 w-2.5 rounded-full",
              phase.order === 1 ? "bg-primary" : "bg-muted-foreground/35"
            )}
            key={phase.key}
          />
        ))}
      </div>
      <p className="truncate text-muted-foreground text-xs">
        Phase 1 of {PHASES.length}
        <span className="@[500px]:inline hidden">: {FIRST_PHASE?.title}</span>
      </p>
    </div>
  );
}

function startHint({
  isMobile,
  isSignedIn,
}: {
  isMobile: boolean;
  isSignedIn: boolean;
}) {
  if (!isSignedIn) {
    return "Each idea is saved as a project on your account, so testing one needs you signed in.";
  }
  if (isMobile) {
    return "The idea is saved as a project you can rename.";
  }
  return "Enter starts the test, Shift+Enter adds a line. The idea is saved as a project you can rename.";
}

export function IdeaStart({
  chatId,
  onOpenPlainChat,
}: {
  chatId: string;
  onOpenPlainChat: () => void;
}) {
  const textareaId = useId();
  const hintId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [description, setDescription] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  // A synchronous latch beside the state: two Enters inside one frame both
  // read `isStarting` as false, and each would create a project.
  const startingRef = useRef(false);
  const { data: session, isPending: isSessionPending } = useSession();
  const isSignedIn = Boolean(session?.user);
  const startIdeaTest = useStartIdeaTest(chatId);
  const isMobile = useIsMobile();

  const hasText = description.trim().length > 0;
  const canStart = isSignedIn && hasText && !isStarting;

  const start = useCallback(async () => {
    if (startingRef.current || !isSignedIn || !description.trim()) {
      return;
    }
    startingRef.current = true;
    setIsStarting(true);
    try {
      await startIdeaTest(description);
      // Sent: the route has moved to the new project's chat and this screen
      // is hidden. The latch stays set so nothing here can send it twice.
    } catch {
      startingRef.current = false;
      setIsStarting(false);
      toast.error("Could not create a project for this idea. Try again.");
    }
  }, [description, isSignedIn, startIdeaTest]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    start();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The composer's rule (`multimodal-input.tsx`): a phone keyboard has no
    // Shift, so there Return adds a line and only Ctrl+Enter sends. A stray
    // Return must not create a project from half an idea.
    const wantsSend = isMobile ? event.ctrlKey : !event.shiftKey;
    if (event.key === "Enter" && wantsSend && !event.nativeEvent.isComposing) {
      event.preventDefault();
      start();
    }
  };

  const pickExample = (text: string) => {
    setDescription(text);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      // Put the caret at the end so the founder can carry on typing.
      requestAnimationFrame(() => {
        textarea.setSelectionRange(text.length, text.length);
      });
    }
  };

  return (
    <section aria-labelledby={`${textareaId}-heading`} className="w-full">
      <h1
        className="text-balance font-semibold text-2xl text-foreground tracking-tight sm:text-3xl"
        id={`${textareaId}-heading`}
      >
        Test an idea before you build it
      </h1>
      <p className="mt-2 max-w-prose text-pretty text-muted-foreground text-sm sm:text-base">
        Describe who has the problem and what you would build. An interviewer
        takes it through eight phases, and each phase ends at a gate that opens
        only on evidence.
      </p>

      <form
        className="mt-5 rounded-xl border bg-muted transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
        onSubmit={handleSubmit}
      >
        <label className="sr-only" htmlFor={textareaId}>
          Describe your idea
        </label>
        <textarea
          aria-describedby={hintId}
          autoFocus
          className="block max-h-[40svh] min-h-32 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60 sm:min-h-36"
          disabled={isStarting}
          id={textareaId}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Who has the problem, how often it hurts, and what you would build for them"
          ref={textareaRef}
          value={description}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pt-1 pb-3">
          <PhaseTrack />
          {isSignedIn || isSessionPending ? (
            <Button
              className="shrink-0"
              disabled={!canStart}
              size="sm"
              type="submit"
            >
              {isStarting ? (
                <>
                  <Spinner />
                  Starting
                </>
              ) : (
                "Start the idea test"
              )}
            </Button>
          ) : (
            <Button asChild className="shrink-0" size="sm">
              <InternalLink href="/login">Sign in to start</InternalLink>
            </Button>
          )}
        </div>
      </form>
      <p className="mt-2 text-muted-foreground text-xs" id={hintId}>
        {startHint({ isMobile, isSignedIn: isSignedIn || isSessionPending })}
      </p>

      <SuggestedActions
        className="mt-5"
        disabled={isStarting}
        onPick={pickExample}
      />

      <p className="mt-8 text-muted-foreground text-sm">
        Not an idea, just a quick question?{" "}
        <Button
          className="h-auto p-0 align-baseline"
          disabled={isStarting}
          onClick={onOpenPlainChat}
          type="button"
          variant="link"
        >
          Open a plain chat
        </Button>
      </p>
    </section>
  );
}
