"use client";
import type { DataUIPart } from "ai";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { ArtifactMetadata } from "@/components/create-artifact";
import { useArtifact } from "@/hooks/use-artifact";
import type { CustomUIDataTypes, UiToolName } from "@/lib/ai/types";
import {
  codeArtifact,
  getCodeArtifactMetadata,
} from "@/lib/artifacts/code/client";
import {
  getSheetArtifactMetadata,
  sheetArtifact,
} from "@/lib/artifacts/sheet/client";
import { textArtifact } from "@/lib/artifacts/text/client";
import { useDataStream } from "@/lib/stores/hooks-data-stream";
import { useChatInput } from "@/providers/chat-input-provider";

function createTypedMetadataSetter<M extends ArtifactMetadata>(
  setMetadata: Dispatch<SetStateAction<ArtifactMetadata>>,
  coerce: (metadata: ArtifactMetadata) => M
): Dispatch<SetStateAction<M>> {
  return (value) => {
    setMetadata((current) => {
      const typedCurrent = coerce(current);
      return typeof value === "function" ? value(typedCurrent) : value;
    });
  };
}

function handleResearchUpdate({
  delta,
  setSelectedTool,
}: {
  delta: DataUIPart<CustomUIDataTypes>;
  setSelectedTool: Dispatch<SetStateAction<UiToolName | null>>;
}): void {
  if (delta.type === "data-researchUpdate") {
    const update = delta.data;
    if (update?.type === "completed") {
      setSelectedTool((current) =>
        current === "deepResearch" ? null : current
      );
    }
  }
}

/**
 * Process artifact stream parts (e.g., data-suggestion for text artifacts).
 * Dispatches to artifact-specific onStreamPart handlers.
 */
function processArtifactStreamPart({
  delta,
  artifact,
  setArtifact,
  setMetadata,
}: {
  delta: DataUIPart<CustomUIDataTypes>;
  artifact: ReturnType<typeof useArtifact>["artifact"];
  setArtifact: ReturnType<typeof useArtifact>["setArtifact"];
  setMetadata: ReturnType<typeof useArtifact>["setMetadata"];
}): void {
  switch (artifact.kind) {
    case "code":
      codeArtifact.onStreamPart?.({
        streamPart: delta,
        setArtifact,
        setMetadata: createTypedMetadataSetter(
          setMetadata,
          getCodeArtifactMetadata
        ),
      });
      break;
    case "sheet":
      sheetArtifact.onStreamPart?.({
        streamPart: delta,
        setArtifact,
        setMetadata: createTypedMetadataSetter(
          setMetadata,
          getSheetArtifactMetadata
        ),
      });
      break;
    case "text":
      textArtifact.onStreamPart?.({
        streamPart: delta,
        setArtifact,
        setMetadata,
      });
      break;
    default:
      break;
  }
}

export function DataStreamHandler() {
  const { dataStream } = useDataStream();
  const { artifact, setArtifact, setMetadata } = useArtifact();
  const lastProcessedIndex = useRef(-1);
  const { setSelectedTool } = useChatInput();

  useEffect(() => {
    if (!dataStream?.length) {
      return;
    }

    const newDeltas = dataStream.slice(lastProcessedIndex.current + 1);
    lastProcessedIndex.current = dataStream.length - 1;

    for (const delta of newDeltas) {
      handleResearchUpdate({ delta, setSelectedTool });

      processArtifactStreamPart({
        delta,
        artifact,
        setArtifact,
        setMetadata,
      });
    }
  }, [dataStream, setArtifact, setMetadata, artifact, setSelectedTool]);

  return null;
}
