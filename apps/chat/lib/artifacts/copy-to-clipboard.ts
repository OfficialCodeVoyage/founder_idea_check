/**
 * THE COPY BUTTON, MADE HONEST.
 *
 * Reported 2026-08-21: *"The copy button on the report does not work.
 * [copying] as text did not work."* The founder was shown "Copied to
 * clipboard!" and got nothing. Three defects lived in five lines of
 * lib/artifacts/text/client.tsx:
 *
 *   1. `content` was never checked for emptiness, so with the dead document
 *      stream in play it wrote `""` and called that a success.
 *   2. `navigator.clipboard.writeText(content)` was neither awaited nor
 *      caught. It rejects on a non-secure context, a denied permission, or an
 *      unfocused document, and the rejection went nowhere.
 *   3. `toast.success(...)` fired UNCONDITIONALLY, before any outcome existed.
 *
 * The button therefore did not look broken — it looked like it lied, which is
 * worse. `components/message-actions.tsx` already had the right shape (guard
 * empty → await → report the actual outcome) but it is a React hook and cannot
 * be called from an artifact action, which is a plain object outside the
 * component tree. This is that same shape, callable from anywhere.
 */

/**
 * WHAT ACTUALLY HAPPENED TO THE CLIPBOARD.
 *
 * THE FAILED ARM CARRIES NO CHARACTER COUNT. There is no `chars: 0` for a copy
 * that did not happen, because a zero standing in for "it did not happen" is
 * the bug family this codebase keeps finding — and because the only reason
 * this union exists is that a success was once reported for a copy that never
 * occurred.
 */
export type CopyOutcome =
  | { readonly copied: true; readonly chars: number }
  | {
      readonly copied: false;
      /** Shown to the founder verbatim. Never blank. */
      readonly why: string;
    };

/**
 * Copy `content`, and say truthfully whether it worked.
 *
 * `what` names the thing in the refusal — "text", "code", "data" — so an empty
 * artifact reads as "There's no code to copy!" rather than a generic shrug.
 * Callers toast the outcome; this function deliberately raises no UI of its own
 * so it can be tested without a DOM.
 */
export async function copyArtifactToClipboard({
  content,
  what,
}: {
  content: string;
  what: string;
}): Promise<CopyOutcome> {
  // GUARD FIRST. This is the case that actually bit: a document whose stream
  // died has `content === ""`, and writing an empty string to the clipboard
  // "succeeds" at the API level while destroying whatever the founder had
  // there before.
  if (content.trim().length === 0) {
    return { copied: false, why: `There's no ${what} to copy!` };
  }

  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) {
    return {
      copied: false,
      why: "This browser will not give the page clipboard access — copy the text manually.",
    };
  }

  try {
    await clipboard.writeText(content);
    return { copied: true, chars: content.length };
  } catch (error) {
    // writeText rejects on an insecure origin, a denied permission, or a
    // document that does not have focus. Every one of those is a real, common
    // failure the founder needs told about, and every one of them was silently
    // discarded before this.
    const detail = error instanceof Error ? error.message : String(error);
    return { copied: false, why: `Could not copy to clipboard: ${detail}` };
  }
}
