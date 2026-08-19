import { CircleDashedIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";
import { PersonaAttributeRow } from "@/components/persona/persona-attribute-row";
import { PersonaEvidenceList } from "@/components/persona/persona-evidence-list";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  assessPersonaReadiness,
  personaAttributeEntries,
} from "@/lib/personas/normalize";
import {
  MIN_OBSERVABLE_ATTRIBUTES,
  PERSONA_INTERVIEW_FLOOR,
  type PersonaArtifact,
} from "@/lib/personas/types";
import { cn } from "@/lib/utils";

/**
 * Renders ONE version of a persona artifact.
 *
 * PRESENTATIONAL AND SERVER-RENDERABLE: no hooks, no fetching, no "use client".
 * It is handed a parsed `PersonaArtifact` and renders exactly what is in it. The
 * version history, the regenerate button and the diff between versions belong to
 * whichever surface embeds this (the artifact panel today, the canvas in step 7)
 * — this component's single job is to make it impossible to read a persona
 * without also reading where it came from.
 *
 * The structural readiness list at the bottom is the ARTIFACT's self-report and
 * says so out loud. It is NOT the phase gate: advance is decided by decideGate()
 * over the whole transcript and fact store, and a founder who mistook a full set
 * of green ticks here for a passed phase would be badly misled.
 */
export function PersonaCard({
  artifact,
  version,
  className,
}: {
  artifact: PersonaArtifact;
  /** 1-based version number from orderPersonaVersions, when there is a history. */
  version?: number;
  className?: string;
}) {
  const { persona } = artifact;
  const readiness = assessPersonaReadiness(persona);
  const unmet = readiness.checks.filter((c) => !c.satisfied);
  const thinObservables =
    persona.observableAttributes.length < MIN_OBSERVABLE_ATTRIBUTES;

  return (
    <Card className={cn("gap-4 py-4", className)}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{persona.label}</CardTitle>
          {version === undefined ? null : (
            <Badge variant="secondary">v{version}</Badge>
          )}
          {readiness.structurallyComplete ? null : (
            <Badge className="gap-1 text-muted-foreground" variant="outline">
              <CircleDashedIcon aria-hidden="true" className="size-3" />
              Incomplete
            </Badge>
          )}
        </div>
        <CardDescription>
          Every line below is either sourced or marked as not established.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/*
          THE DEGRADED BANNER. Non-empty degradedReasons means this version is a
          refusal, not a finding — the generator was never called, or it failed,
          or nothing it returned could be sourced. Without this the founder sees
          a card full of "not established" rows and reasonably concludes their
          project is thin, when in fact the model never ran.
        */}
        {artifact.degradedReasons.length > 0 ? (
          <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-destructive"
            />
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                This version is not a finding. It could not be generated.
              </p>
              <ul className="space-y-0.5 text-muted-foreground">
                {artifact.degradedReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <section>
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Filterable attributes
          </h3>
          {persona.observableAttributes.length === 0 ? (
            <p className="mt-2 text-muted-foreground text-sm">
              None established. Without at least {MIN_OBSERVABLE_ATTRIBUTES}{" "}
              attributes you could filter a list on, this is a description
              rather than a segment you can go and find.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {persona.observableAttributes.map((observable) => (
                <div key={observable.dimension}>
                  <Badge variant="secondary">
                    {observable.dimension}: {observable.value}
                  </Badge>
                  <PersonaEvidenceList evidence={observable.evidence} />
                </div>
              ))}
              {thinObservables ? (
                <p className="text-muted-foreground text-sm">
                  {persona.observableAttributes.length} of{" "}
                  {MIN_OBSERVABLE_ATTRIBUTES} filterable attributes.
                </p>
              ) : null}
            </div>
          )}
        </section>

        <section>
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Attributes
          </h3>
          <div className="mt-1">
            {personaAttributeEntries(persona).map((entry) => (
              <PersonaAttributeRow entry={entry} key={entry.spec.key} />
            ))}
          </div>
        </section>

        <section>
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Deliberately not served first
          </h3>
          {persona.excludedSegments.length === 0 ? (
            <p className="mt-2 text-muted-foreground text-sm">
              Nothing has been deprioritised, so no beachhead has actually been
              chosen.
            </p>
          ) : (
            <ul className="mt-2 space-y-3">
              {persona.excludedSegments.map((excluded) => (
                <li key={excluded.segment}>
                  <p className="text-sm">
                    <span className="font-medium">{excluded.segment}</span> —{" "}
                    {excluded.reason}
                  </p>
                  <PersonaEvidenceList evidence={excluded.evidence} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Interviews
          </h3>
          {persona.interviews.status === "counted" ? (
            <div className="mt-2">
              <div className="flex items-center gap-2 text-sm">
                <UsersIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                <span>
                  {persona.interviews.count} evidenced of{" "}
                  {PERSONA_INTERVIEW_FLOOR} needed
                </span>
                {persona.interviews.meetsFloor ? null : (
                  <Badge className="text-muted-foreground" variant="outline">
                    Below the floor
                  </Badge>
                )}
              </div>
              <PersonaEvidenceList evidence={persona.interviews.evidence} />
            </div>
          ) : (
            <p className="mt-2 text-muted-foreground text-sm">
              {persona.interviews.gap}
            </p>
          )}
        </section>

        <section>
          <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            What this persona still needs
          </h3>
          <p className="mt-1 text-muted-foreground text-xs">
            A structural check of the artifact. It is not the phase gate — that
            reads the whole conversation and decides separately.
          </p>
          {unmet.length === 0 ? (
            <p className="mt-2 text-sm">
              Structurally complete. Every blocking attribute is evidenced.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {unmet.map((item) => (
                <li
                  className="flex gap-2 text-muted-foreground text-sm"
                  key={item.criterionId}
                >
                  <CircleDashedIcon
                    aria-hidden="true"
                    className="mt-1 size-3 shrink-0"
                  />
                  <span>
                    {item.gap}
                    {item.severity === "advisory" ? " (advisory)" : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
