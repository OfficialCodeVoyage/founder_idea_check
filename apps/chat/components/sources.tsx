import { ArrowRight, FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { SearchResultItem } from "@/tools/platform/research-updates-schema";
import { Favicon } from "./favicon";
import { FaviconGroup } from "./favicon-group";

/**
 * Radix warns, once per open, when a dialog has no description for assistive
 * technology to announce. The visible title says what the list is; this says
 * what its rows do.
 */
const SOURCES_DESCRIPTION =
  "Pages cited in this answer. Each one opens in a new tab.";

const SourcesList = ({
  sources,
}: {
  sources: SearchResultItem[] | undefined;
}) => (
  <div className="space-y-3">
    {/*
      Keyed on the url, which is unique only because `toSearchResults` in
      deep-research/sidecar-search.ts dedupes by url. The sidecar's own dedup is
      by text similarity and skips empty-text items entirely, so without that
      step this key collides — see the note in components/research-task.tsx.
    */}
    {sources?.map((source: SearchResultItem) => (
      <a
        className="block rounded-lg bg-secondary p-4 transition-colors hover:bg-accent"
        href={source.url}
        key={source.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        <div className="flex items-start gap-3">
          <div className="mt-1 shrink-0">
            <Favicon url={source.url} />
          </div>
          <div className="flex flex-col gap-1">
            <h4 className="font-medium text-sm leading-tight">
              {source.title}
            </h4>
          </div>
        </div>
      </a>
    ))}
  </div>
);

const AllSourcesView = ({
  sources,
  id,
}: {
  sources: SearchResultItem[] | undefined;
  id?: string;
}) => {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const title = "All Sources";

  if (isDesktop) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <button className="hidden" id={id} type="button">
            Show All
          </button>
        </DialogTrigger>
        <DialogContent
          className={cn("max-h-[80vh] overflow-y-auto", "max-w-4xl")}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              {title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {SOURCES_DESCRIPTION}
            </DialogDescription>
          </DialogHeader>
          <SourcesList sources={sources} />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer>
      <DrawerTrigger asChild>
        <button className="hidden" id={id} type="button">
          Show All
        </button>
      </DrawerTrigger>
      <DrawerContent className="h-[85vh]">
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {title}
          </DrawerTitle>
          <DrawerDescription className="sr-only">
            {SOURCES_DESCRIPTION}
          </DrawerDescription>
        </DrawerHeader>
        <div className="overflow-y-auto p-4">
          <SourcesList sources={sources} />
        </div>
      </DrawerContent>
    </Drawer>
  );
};

function ShowSourcesButton({
  sources,
  dialogId,
}: {
  sources: SearchResultItem[];
  dialogId: string;
}) {
  return (
    <button
      className="group flex items-center justify-center gap-2 rounded-lg border border-border p-2.5 transition-colors hover:bg-accent"
      onClick={() => document.getElementById(dialogId)?.click()}
      type="button"
    >
      <FaviconGroup
        className="mr-1.5"
        maxVisible={3}
        sources={sources.map((s) => ({ url: s.url }))}
      />
      <span className="text-muted-foreground text-xs group-hover:text-foreground">
        {sources.length} Sources
      </span>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
    </button>
  );
}

export const Sources = ({ sources }: { sources: SearchResultItem[] }) => {
  if (sources.length === 0) {
    return null;
  }

  const sourcesDialogId = "show-all-sources-dialog";

  return (
    <div className="space-y-3">
      <ShowSourcesButton dialogId={sourcesDialogId} sources={sources} />
      <div className="hidden">
        <AllSourcesView id={sourcesDialogId} sources={sources} />
      </div>
    </div>
  );
};
