import Firecrawl, {
  type Document,
  type SearchRequest,
  type SearchResultWeb,
} from "@mendable/firecrawl-js";
import { type TavilySearchOptions, tavily } from "@tavily/core";
import { env } from "@/lib/env";
import { createModuleLogger } from "@/lib/logger";

export type SearchProviderOptions =
  | ({
      provider: "tavily";
    } & Omit<TavilySearchOptions, "limit">)
  | ({
      provider: "firecrawl";
    } & Omit<SearchRequest, "query">);

export interface WebSearchResult {
  content: string;
  source: "web";
  title: string;
  url: string;
}

export interface WebSearchResponse {
  error?: string;
  results: WebSearchResult[];
}

// Initialize search providers lazily to avoid runtime errors when keys are missing
const tvly = env.TAVILY_API_KEY ? tavily({ apiKey: env.TAVILY_API_KEY }) : null;
const firecrawl = env.FIRECRAWL_API_KEY
  ? new Firecrawl({ apiKey: env.FIRECRAWL_API_KEY })
  : null;

const log = createModuleLogger("tools/steps/web-search");

/**
 * A Firecrawl web hit is a bare listing (`SearchResultWeb`) or, when
 * `scrapeOptions` asks for formats, a scraped `Document`. The API may carry the
 * title and url at the top level or only inside `metadata`, so each field reads
 * the top level first and falls back to the metadata.
 */
function toWebSearchResult(item: SearchResultWeb | Document): WebSearchResult {
  const metadata = "metadata" in item ? item.metadata : undefined;
  const title = ("title" in item ? item.title : undefined) || metadata?.title;
  const url =
    ("url" in item ? item.url : undefined) ||
    metadata?.url ||
    metadata?.sourceURL;
  const markdown = "markdown" in item ? item.markdown : undefined;
  const description =
    ("description" in item ? item.description : undefined) ||
    metadata?.description;

  return {
    source: "web",
    title: title || "",
    url: url || "",
    content: markdown || description || "",
  };
}

function extractErrorInfo(error: unknown): {
  message: string | undefined;
  stack: string | undefined;
  status: number | undefined;
  data: unknown;
} {
  let message: string | undefined;
  let stack: string | undefined;
  let status: number | undefined;
  let data: unknown;

  if (typeof error === "object" && error !== null) {
    if (
      "message" in error &&
      typeof (error as { message: unknown }).message === "string"
    ) {
      message = (error as { message: string }).message;
    }
    if (
      "stack" in error &&
      typeof (error as { stack: unknown }).stack === "string"
    ) {
      stack = (error as { stack: string }).stack;
    }
    // Firecrawl's SdkError carries `status` and `details` at the top level;
    // Tavily's axios client nests the same facts under `response`.
    const {
      status: topStatus,
      details,
      response,
    } = error as {
      status?: unknown;
      details?: unknown;
      response?: { status?: number; data?: unknown };
    };
    status = typeof topStatus === "number" ? topStatus : response?.status;
    data = details ?? response?.data;
  }

  return { message, stack, status, data };
}

export async function webSearchStep({
  query,
  maxResults,
  providerOptions,
}: {
  query: string;
  maxResults: number;
  providerOptions: SearchProviderOptions;
}): Promise<WebSearchResponse> {
  try {
    let results: WebSearchResult[] = [];

    if (providerOptions.provider === "tavily") {
      if (!tvly) {
        return {
          results: [],
          error:
            "Tavily is not configured. Set TAVILY_API_KEY or choose a different provider.",
        };
      }
      const response = await tvly.search(query, {
        searchDepth: providerOptions.searchDepth || "basic",
        maxResults,
        includeAnswer: true,
        ...providerOptions,
      });

      results = response.results.map((r) => ({
        source: "web",
        title: r.title,
        url: r.url,
        content: r.content,
      }));
    } else if (providerOptions.provider === "firecrawl") {
      if (!firecrawl) {
        return {
          results: [],
          error:
            "Firecrawl is not configured. Set FIRECRAWL_API_KEY or choose a different provider.",
        };
      }
      const response = await firecrawl.search(query, {
        timeout: providerOptions.timeout || 15_000,
        limit: maxResults,
        scrapeOptions: { formats: ["markdown"] },
        ...providerOptions,
      });

      // `response.data` is a getter that throws in v4: results are grouped by
      // source, and this step only wants the web group.
      results = (response.web ?? []).map(toWebSearchResult);
    }

    log.debug(
      { query, maxResults, provider: providerOptions.provider },
      "webSearchStep success"
    );
    return { results };
  } catch (error: unknown) {
    const { message, stack, status, data } = extractErrorInfo(error);

    log.error(
      {
        err: error,
        message,
        stack,
        status,
        data,
        query,
        providerOptions,
      },
      "Error in webSearchStep"
    );
    return {
      results: [],
      error: JSON.stringify(
        {
          message,
          status,
          data,
        },
        null,
        2
      ),
    };
  }
}
