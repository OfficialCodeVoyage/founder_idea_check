// Client-side tool renderers installed via `chatjs add`.
// This file is fully managed by the CLI — do not edit manually.
import type { ToolRendererRegistry } from "@/lib/ai/tool-renderer-registry";

// [chatjs-registry:ui-imports]
import { GetWeatherRenderer } from "@/tools/chatjs/get-weather/renderer";
import { RetrieveUrlRenderer } from "@/tools/chatjs/retrieve-url/renderer";
import { WordCountRenderer } from "@/tools/chatjs/word-count/renderer";
// [/chatjs-registry:ui-imports]

export const ui = {
  // [chatjs-registry:ui]
  "tool-getWeather": GetWeatherRenderer,
  "tool-retrieveUrl": RetrieveUrlRenderer,
  "tool-wordCount": WordCountRenderer,
  // [/chatjs-registry:ui]
} satisfies ToolRendererRegistry;
