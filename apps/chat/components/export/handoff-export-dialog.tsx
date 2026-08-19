"use client";

import { useMutation } from "@tanstack/react-query";
import { DownloadIcon, PackageIcon } from "lucide-react";
import { useState } from "react";
import type { BuildHandoffResult } from "@/app/actions/build-handoff";
import { buildProjectHandoff } from "@/app/actions/build-handoff";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ExportFile, ExportReadiness } from "@/lib/export/types";

/**
 * The handoff export entry point (EXPORT-INTEGRATION-NOTES.md §4d).
 *
 * 🚨 THE BUTTON IS NEVER DISABLED ON READINESS, AND MUST NOT BECOME SO.
 * `readiness.level` is `empty | partial | complete`, and `partial` is a
 * FIRST-CLASS success: a founder who stopped at phase 4 still gets an honest
 * repo whose documents say, in writing, what is missing. Gating the button on
 * `complete` would delete the main reason the feature exists — and `empty` is
 * already refused by buildHandoff() itself, on the server, where the refusal
 * names the rule that fired. A disabled button here would be a second, weaker,
 * client-side copy of a decision the pure layer already makes correctly.
 */

const READINESS_TONE: Record<ExportReadiness["level"], string> = {
  empty: "bg-destructive text-destructive-foreground",
  partial: "bg-secondary text-secondary-foreground",
  complete: "bg-primary text-primary-foreground",
};

const READINESS_LABEL: Record<ExportReadiness["level"], string> = {
  empty: "NOTHING TO EXPORT",
  partial: "PARTIAL",
  complete: "COMPLETE",
};

function ReadinessBanner({ readiness }: { readiness: ExportReadiness }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
      <Badge className={READINESS_TONE[readiness.level]}>
        {READINESS_LABEL[readiness.level]}
      </Badge>
      <span className="text-muted-foreground">{readiness.reason}</span>
      <span className="text-muted-foreground text-xs">
        {readiness.passedPhaseKeys.length} of {readiness.phaseCount} phases
        passed · {readiness.factCount} facts
      </span>
    </div>
  );
}

function downloadFile(file: ExportFile) {
  // A real Blob URL and a real <a download>, not a data: URI — browsers block
  // script-initiated data: downloads. Revoked on the next tick; the click has
  // already read the URL by then.
  const url = URL.createObjectURL(
    new Blob([file.contents], { type: "text/plain;charset=utf-8" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.path.split("/").at(-1) ?? "export.txt";
  anchor.click();
  URL.revokeObjectURL(url);
}

function FileList({
  files,
  selected,
  onSelect,
}: {
  files: ExportFile[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <ScrollArea className="h-72 w-full shrink-0 rounded-md border sm:w-64">
      <ul className="p-1">
        {files.map((file) => (
          <li key={file.path}>
            <button
              className={`w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent ${
                file.path === selected ? "bg-accent" : ""
              }`}
              onClick={() => onSelect(file.path)}
              type="button"
            >
              {file.path}
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

function HandoffPlanView({
  result,
}: {
  result: Extract<BuildHandoffResult, { status: "ready" }>;
}) {
  const [selected, setSelected] = useState(result.plan.files[0]?.path ?? "");
  const active =
    result.plan.files.find((file) => file.path === selected) ??
    result.plan.files[0];

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <ReadinessBanner readiness={result.readiness} />
      <p className="text-muted-foreground text-xs">
        <span className="font-mono">{result.plan.repoName}/</span> ·{" "}
        {result.plan.files.length} files ·{" "}
        {result.plan.notEstablishedKeys.length} facts never established ·{" "}
        {result.plan.lowConfidenceKeys.length} low confidence
      </p>
      <div className="flex min-h-0 flex-col gap-3 sm:flex-row">
        <FileList
          files={result.plan.files}
          onSelect={setSelected}
          selected={active?.path ?? ""}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-xs">{active?.path}</span>
            {active ? (
              <Button
                onClick={() => downloadFile(active)}
                size="sm"
                variant="outline"
              >
                <DownloadIcon className="size-3" />
                Download
              </Button>
            ) : null}
          </div>
          <ScrollArea className="h-72 rounded-md border">
            <pre className="whitespace-pre-wrap p-3 font-mono text-xs">
              {active?.contents}
            </pre>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function HandoffBody({ result }: { result: BuildHandoffResult }) {
  if (result.status === "unauthorized" || result.status === "not-found") {
    return (
      <p className="text-muted-foreground text-sm">
        This project could not be read.
      </p>
    );
  }
  if (result.status === "refused") {
    // A refusal, shown as a refusal. buildHandoff() names the rule that fired;
    // paraphrasing it here would put a second, softer explanation on screen.
    return (
      <div className="flex flex-col gap-3">
        <ReadinessBanner readiness={result.readiness} />
        <p className="text-sm">{result.reason}</p>
      </div>
    );
  }
  return <HandoffPlanView result={result} />;
}

export function HandoffExportDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const build = useMutation({
    mutationFn: () => buildProjectHandoff({ projectId }),
  });

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !build.data) {
          build.mutate();
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        {/* No `disabled` here, and none keyed on readiness. See the file header. */}
        <Button className="h-6 shrink-0 px-2 text-xs" size="sm" variant="ghost">
          <PackageIcon className="size-3" />
          Export repo
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Handoff export</DialogTitle>
          <DialogDescription>
            Every document below is generated from the facts this project
            established, and says so where a fact is missing or low confidence.
          </DialogDescription>
        </DialogHeader>
        {build.isPending ? (
          <p className="text-muted-foreground text-sm">Building the repo…</p>
        ) : null}
        {build.isError ? (
          <p className="text-destructive text-sm">
            The export could not be built: {build.error.message}
          </p>
        ) : null}
        {build.data ? <HandoffBody result={build.data} /> : null}
      </DialogContent>
    </Dialog>
  );
}
