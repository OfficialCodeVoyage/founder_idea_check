"use client";

import { memo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Example ideas for the home screen's idea box. A click fills the box and
 * sends nothing: an example is there to show what a usable description looks
 * like (who has the problem, how it hurts, what you would build), and the
 * founder should edit it into their own idea before the gate judges it.
 */
const EXAMPLE_IDEAS = [
  {
    label: "Co-op puzzle game",
    text: "A small co-op puzzle game for two players on one couch, sold on Steam for about $10. I think couples who game together run out of short, relaxed games they can finish in an evening.",
  },
  {
    label: "Late invoice reminders",
    text: "Freelance designers lose days every month chasing late invoices. I would build a tool that sends polite, escalating reminders from their own email until the client pays.",
  },
  {
    label: "Meals for night-shift nurses",
    text: "Nurses on rotating night shifts skip meals or live on vending machines. I would build a weekly meal plan that follows their shift calendar and fits a 20-minute break.",
  },
] as const;

function PureSuggestedActions({
  className,
  disabled,
  onPick,
}: {
  className?: string;
  disabled?: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-testid="suggested-actions"
    >
      <span className="text-muted-foreground text-sm">For example:</span>
      {EXAMPLE_IDEAS.map((idea) => (
        <Button
          className="h-auto min-h-8 whitespace-normal rounded-full px-3 py-1 text-left font-normal"
          disabled={disabled}
          key={idea.label}
          onClick={() => onPick(idea.text)}
          size="sm"
          title={idea.text}
          type="button"
          variant="outline"
        >
          {idea.label}
        </Button>
      ))}
    </div>
  );
}

export const SuggestedActions = memo(PureSuggestedActions);
