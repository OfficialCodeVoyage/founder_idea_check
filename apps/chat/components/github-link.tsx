import { GitIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { REPOSITORY_URL } from "@/lib/project-links";

export function GitHubLink() {
  return (
    <Button asChild size="icon" type="button" variant="ghost">
      <a
        className="flex items-center justify-center"
        href={REPOSITORY_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        <GitIcon size={20} />
      </a>
    </Button>
  );
}
