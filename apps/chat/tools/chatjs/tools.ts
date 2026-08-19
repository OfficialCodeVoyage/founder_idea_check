// Server-side tools installed via `chatjs add`.
// This file is fully managed by the CLI — do not edit manually.

// [chatjs-registry:tool-imports]
import { getWeather } from "@/tools/chatjs/get-weather/tool";
import { wordCount } from "@/tools/chatjs/word-count/tool";
// [/chatjs-registry:tool-imports]

export const tools = {
  // [chatjs-registry:tools]
  getWeather,
  wordCount,
  // [/chatjs-registry:tools]
} as const;
