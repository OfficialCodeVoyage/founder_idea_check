"use client";

import { Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import {
  deleteSimulationProfileAction,
  type SaveSimulationProfileResult,
  saveSimulationProfile,
} from "@/app/actions/save-simulation-profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SimulationProfile } from "@/lib/db/schema";

/**
 * WHO IS IN THE ROOM — the founder's own demographics for each agent OASIS will
 * spawn.
 *
 * Deliberately plain, and deliberately empty until a human fills it in. The
 * standing sentence under the heading is the whole point of the feature: these
 * four fields are attributable to the person who typed them, which is why they
 * live in their own table and never inside the versioned persona artifact.
 *
 * Gender and country are FREE TEXT, not dropdowns. A closed list is a claim
 * about which answers are legitimate, and OASIS only needs a string.
 */

type PersonaOption = {
  personaDocumentId: string;
  label: string | null;
  title: string;
};

type Draft = {
  handle: string;
  age: string;
  gender: string;
  country: string;
  mbti: string;
};

const EMPTY_DRAFT: Draft = {
  age: "",
  country: "",
  gender: "",
  handle: "",
  mbti: "",
};

function toDraft(profile: SimulationProfile): Draft {
  return {
    age: String(profile.age),
    country: profile.country,
    gender: profile.gender,
    handle: profile.handle,
    mbti: profile.mbti ?? "",
  };
}

function resultMessage(result: SaveSimulationProfileResult): string | null {
  switch (result.status) {
    case "saved":
      return null;
    case "unauthorized":
      return "Sign in to edit this.";
    case "not-found":
      return "That seat is not part of this project.";
    case "handle-taken":
      return `“${result.handle}” is already used by another seat in this project.`;
    case "seat-limit":
      return `A simulation seats at most ${result.limit} agents. Remove a seat before adding another.`;
    default:
      return result.problems.join("; ");
  }
}

function SeatRow({
  draft,
  onChange,
  onDelete,
  onSave,
  pending,
  seatKey,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  onDelete: (() => void) | null;
  onSave: () => void;
  pending: boolean;
  /** Unique per row, so each label points at its own input. */
  seatKey: string;
}) {
  const fieldId = (field: string) => `seat-${seatKey}-${field}`;
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border p-2">
      <label
        className="flex flex-col gap-1 text-xs"
        htmlFor={fieldId("handle")}
      >
        Name
        <Input
          className="h-8 w-36"
          id={fieldId("handle")}
          onChange={(event) =>
            onChange({ ...draft, handle: event.target.value })
          }
          placeholder="Ana R"
          value={draft.handle}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs" htmlFor={fieldId("age")}>
        Age
        <Input
          className="h-8 w-20"
          id={fieldId("age")}
          inputMode="numeric"
          onChange={(event) => onChange({ ...draft, age: event.target.value })}
          placeholder="42"
          value={draft.age}
        />
      </label>
      <label
        className="flex flex-col gap-1 text-xs"
        htmlFor={fieldId("gender")}
      >
        Gender
        <Input
          className="h-8 w-28"
          id={fieldId("gender")}
          onChange={(event) =>
            onChange({ ...draft, gender: event.target.value })
          }
          placeholder="female"
          value={draft.gender}
        />
      </label>
      <label
        className="flex flex-col gap-1 text-xs"
        htmlFor={fieldId("country")}
      >
        Country
        <Input
          className="h-8 w-32"
          id={fieldId("country")}
          onChange={(event) =>
            onChange({ ...draft, country: event.target.value })
          }
          placeholder="United States"
          value={draft.country}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs" htmlFor={fieldId("mbti")}>
        MBTI
        <Input
          className="h-8 w-40"
          id={fieldId("mbti")}
          onChange={(event) => onChange({ ...draft, mbti: event.target.value })}
          placeholder="XXXX — leave blank if unknown"
          value={draft.mbti}
        />
      </label>
      <Button disabled={pending} onClick={onSave} size="sm" variant="secondary">
        Save
      </Button>
      {onDelete ? (
        <Button
          disabled={pending}
          onClick={onDelete}
          size="icon"
          variant="ghost"
        >
          <Trash2 className="size-4" />
          <span className="sr-only">Delete this seat</span>
        </Button>
      ) : null}
    </div>
  );
}

export function SimulationProfileForm({
  projectId,
  personas,
  profiles,
}: {
  projectId: string;
  personas: PersonaOption[];
  profiles: SimulationProfile[];
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(profiles.map((p) => [p.id, toDraft(p)]))
  );
  const [newSeats, setNewSeats] = useState<Record<string, Draft>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (
    personaDocumentId: string,
    draft: Draft,
    id?: string,
    onSaved?: () => void
  ) => {
    startTransition(async () => {
      const result = await saveSimulationProfile({
        // A non-numeric age fails the schema and is reported as a field
        // problem — NOT coerced to 0, which is a real age the check constraint
        // would then reject with a Postgres error the founder cannot read.
        age: Number.parseInt(draft.age, 10),
        country: draft.country,
        gender: draft.gender,
        handle: draft.handle,
        id,
        mbti: draft.mbti,
        personaDocumentId,
        projectId,
      });
      setMessage(resultMessage(result));
      if (result.status === "saved") {
        onSaved?.();
      }
    });
  };

  const remove = (id: string) => {
    startTransition(async () => {
      setMessage(
        resultMessage(await deleteSimulationProfileAction({ id, projectId }))
      );
    });
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-medium text-sm">Who is in the room</h2>
        <p className="mt-1 text-muted-foreground text-xs">
          These four fields are your assumptions, not evidence. They are stored
          separately from the persona so they can never be mistaken for
          something a customer told you — and nothing here is filled in for you.
          A simulation needs at least two people, because divergence between one
          opinion and itself is not a finding.
        </p>
      </div>

      {personas.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No persona to seat anyone against yet. Generate one in phase 3.
        </p>
      ) : null}

      {personas.map((persona) => {
        const seats = profiles.filter(
          (p) => p.personaDocumentId === persona.personaDocumentId
        );
        const pendingDraft = newSeats[persona.personaDocumentId];
        return (
          <div className="space-y-2" key={persona.personaDocumentId}>
            <h3 className="font-medium text-xs">
              {persona.label ?? persona.title}
            </h3>
            {seats.map((seat) => (
              <SeatRow
                draft={drafts[seat.id] ?? toDraft(seat)}
                key={seat.id}
                onChange={(next) =>
                  setDrafts((current) => ({ ...current, [seat.id]: next }))
                }
                onDelete={() => remove(seat.id)}
                onSave={() =>
                  save(
                    persona.personaDocumentId,
                    drafts[seat.id] ?? toDraft(seat),
                    seat.id
                  )
                }
                pending={isPending}
                seatKey={seat.id}
              />
            ))}
            {pendingDraft ? (
              <SeatRow
                draft={pendingDraft}
                onChange={(next) =>
                  setNewSeats((current) => ({
                    ...current,
                    [persona.personaDocumentId]: next,
                  }))
                }
                onDelete={() =>
                  setNewSeats((current) => {
                    const next = { ...current };
                    delete next[persona.personaDocumentId];
                    return next;
                  })
                }
                onSave={() =>
                  save(persona.personaDocumentId, pendingDraft, undefined, () =>
                    setNewSeats((current) => {
                      const next = { ...current };
                      delete next[persona.personaDocumentId];
                      return next;
                    })
                  )
                }
                pending={isPending}
                seatKey={`new-${persona.personaDocumentId}`}
              />
            ) : null}
            <Button
              onClick={() =>
                setNewSeats((current) => ({
                  ...current,
                  [persona.personaDocumentId]: EMPTY_DRAFT,
                }))
              }
              size="sm"
              variant="outline"
            >
              Add someone
            </Button>
          </div>
        );
      })}

      {message ? <p className="text-destructive text-sm">{message}</p> : null}
    </section>
  );
}
