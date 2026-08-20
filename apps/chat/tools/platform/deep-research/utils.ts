import { experimental_createMCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import type { ModelId } from "@/lib/ai/app-models";
import { getAppModelDefinition } from "@/lib/ai/app-models";
import type { StreamWriter } from "@/lib/ai/types";
import { createModuleLogger } from "@/lib/logger";
import { firecrawlWebSearch, tavilyWebSearch } from "../web-search";
import type { DeepResearchRuntimeConfig, SearchAPI } from "./configuration";
import { sidecarWebSearch } from "./sidecar-search";

const log = createModuleLogger("tools/deep-research/utils");

// MCP Utils

type McpClient = Awaited<ReturnType<typeof experimental_createMCPClient>>;

async function loadMcpTools(
  config: DeepResearchRuntimeConfig,
  existingToolNames: Set<string>
): Promise<ToolSet> {
  if (!config.mcp_config?.url) {
    return {};
  }

  let client: McpClient | null = null;
  try {
    // Create MCP client based on configuration
    // Currently supports SSE transport only
    client = await experimental_createMCPClient({
      transport: {
        type: "sse",
        url: config.mcp_config.url,
      },
    });

    // Get all available tools from the MCP server
    const tools = (await client.tools()) as ToolSet;

    // Filter tools based on configuration and existing tools
    const filteredTools: ToolSet = {};

    for (const [toolName, tool] of Object.entries(tools)) {
      // Skip if tool already exists
      if (existingToolNames.has(toolName)) {
        console.log(
          `Skipping tool ${toolName} because a tool with that name already exists`
        );
        continue;
      }

      // If specific tools are configured, only include those
      if (
        config.mcp_config.tools &&
        config.mcp_config.tools.length > 0 &&
        !config.mcp_config.tools.includes(toolName)
      ) {
        console.log(`Skipping tool ${toolName} because it's not in the config`);
        continue;
      }

      filteredTools[toolName] = tool;
    }

    return filteredTools;
  } catch (error) {
    console.error("Failed to load MCP tools:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
    }
    return {};
  } finally {
    // Clean up the client connection
    if (client) {
      await client.close();
    }
  }
}

// Tool Utils

function getSearchTool(
  searchApi: SearchAPI,
  _config: DeepResearchRuntimeConfig,
  dataStream: StreamWriter,
  parentToolCallId?: string
): ToolSet {
  if (searchApi === "tavily") {
    return {
      webSearch: tavilyWebSearch({
        dataStream,
        writeTopLevelUpdates: false,
        toolCallIdOverride: parentToolCallId,
      }),
    };
  }
  if (searchApi === "sidecar") {
    return {
      // Named `webSearch` like the other two arms on purpose: the researcher
      // prompt names the tool, so renaming it per provider would make the
      // prompt depend on which key happens to be set.
      webSearch: sidecarWebSearch({
        dataStream,
        writeTopLevelUpdates: false,
        toolCallIdOverride: parentToolCallId,
      }),
    };
  }
  if (searchApi === "firecrawl") {
    return {
      webSearch: firecrawlWebSearch({
        dataStream,
        writeTopLevelUpdates: false,
        toolCallIdOverride: parentToolCallId,
      }),
    };
  }
  throw new Error(`Unsupported search API: ${searchApi}`);
}

export async function getAllTools(
  config: DeepResearchRuntimeConfig,
  dataStream: StreamWriter,
  id?: string
): Promise<ToolSet> {
  if (config.search_api === "none") {
    const mcpTools = await loadMcpTools(config, new Set<string>());
    return mcpTools;
  }

  const searchTools = getSearchTool(config.search_api, config, dataStream, id);
  const existingToolNames = new Set<string>(Object.keys(searchTools));

  const mcpTools = await loadMcpTools(config, existingToolNames);

  return { ...mcpTools, ...searchTools };
}

/**
 * Conservative floor used when the gateway reports no context window.
 *
 * Not a guess at any particular model's real size — a deliberately small,
 * widely-safe budget. Overshooting would produce a provider-side rejection;
 * undershooting only truncates.
 */
const UNKNOWN_CONTEXT_WINDOW_FALLBACK = 128_000;

/**
 * Context window for a model, in tokens. ALWAYS POSITIVE.
 *
 * A non-positive `context_window` means THE GATEWAY DID NOT REPORT ONE, not
 * that the model accepts zero tokens. OpenAI's /v1/models carries no context
 * window, so `toAiGatewayModel` in lib/ai/gateways/openai-gateway.ts writes 0
 * as a placeholder — and every one of the 126 models in models.generated.ts
 * currently has it.
 *
 * Returning that 0 unchanged is what disabled deep research outright:
 * `truncateMessages(messages, 0)` discarded every message and `generateText`
 * threw "Invalid prompt: messages must not be empty". Zero is not a budget, and
 * an unreported value must not be defaulted to it.
 */
export async function getModelContextWindow(modelId: ModelId): Promise<number> {
  const model = await getAppModelDefinition(modelId);
  if (model.context_window > 0) {
    return model.context_window;
  }
  log.warn(
    { modelId, reported: model.context_window },
    "Gateway reported no context window; using the documented fallback"
  );
  return UNKNOWN_CONTEXT_WINDOW_FALLBACK;
}

// Misc Utils
export function getTodayStr(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
