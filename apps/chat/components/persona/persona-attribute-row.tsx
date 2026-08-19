import { CircleDashedIcon } from "lucide-react";
import { PersonaEvidenceList } from "@/components/persona/persona-evidence-list";
import { Badge } from "@/components/ui/badge";
import type { PersonaAttributeEntry } from "@/lib/personas/normalize";

/**
 * One attribute of a persona.
 *
 * THE NOT-ESTABLISHED STATE IS NOT AN EMPTY STATE. It gets a row, a heading, an
 * icon and a sentence naming the missing thing — the same visual weight as an
 * evidenced attribute. Rendering it as a blank, or omitting the row, would let a
 * persona with two sourced attributes look like a persona with two attributes,
 * and the founder's next action depends entirely on being able to tell those
 * apart.
 */
export function PersonaAttributeRow({
  entry,
}: {
  entry: PersonaAttributeEntry;
}) {
  const { spec, attribute } = entry;

  if (attribute.status === "not-established") {
    return (
      <div className="border-border/60 border-b py-3 last:border-b-0">
        <div className="flex items-center gap-2">
          <h4 className="font-medium text-muted-foreground text-sm">
            {spec.label}
          </h4>
          <Badge className="gap-1 text-muted-foreground" variant="outline">
            <CircleDashedIcon aria-hidden="true" className="size-3" />
            Not established
          </Badge>
        </div>
        <p className="mt-1 text-muted-foreground text-sm">{attribute.gap}</p>
      </div>
    );
  }

  return (
    <div className="border-border/60 border-b py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <h4 className="font-medium text-sm">{spec.label}</h4>
        {attribute.status === "assumed" ? (
          <Badge className="text-muted-foreground" variant="outline">
            [Assumption]
          </Badge>
        ) : null}
      </div>
      <p className="mt-1 text-sm">{attribute.value}</p>
      <PersonaEvidenceList evidence={attribute.evidence} />
    </div>
  );
}
