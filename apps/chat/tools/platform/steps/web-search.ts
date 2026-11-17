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
    } & Omit<SearchRequest, "query" | "sources">);

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
 *
 * `content` is the scraped page only. A hit whose scrape failed has no
 * markdown, and passing its one-line search snippet in the same field would
 * hand the researcher a snippet as if it were the page. A hit with no url is
 * dropped: it cannot be cited, and an empty url would collapse every such hit
 * into one in the caller's url/domain de-duplication.
 */
function toWebSearchResult(
  item: SearchResultWeb | Document
): WebSearchResult | null {
  const metadata = "metadata" in item ? item.metadata : undefined;
  const url =
    ("url" in item ? item.url : undefined) ||
    metadata?.url ||
    metadata?.sourceURL;
  if (!url) {
    return null;
  }
  const title = ("title" in item ? item.title : undefined) || metadata?.title;
  const markdown = "markdown" in item ? item.markdown : undefined;

  return {
    source: "web",
    title: title || "",
    url,
    content: markdown || "",
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
        // v2 computes query highlights by default; this step never reads them,
        // and they cost time inside the timeout above.
        highlights: false,
        ...providerOptions,
        // Results come back grouped by source and this step reads only the web
        // group, so no caller option may ask for another one.
        sources: ["web"],
      });

      // `response.data` is a getter that throws in v4.
      results = (response.web ?? []).flatMap((item) => {
        const result = toWebSearchResult(item);
        return result ? [result] : [];
      });
      if (response.warning) {
        log.warn(
          { query, warning: response.warning, count: results.length },
          "firecrawl search returned a warning"
        );
        // A warning with nothing usable is a failed search, not "nothing
        // found": say why.
        if (results.length === 0) {
          return { results, error: response.warning };
        }
      }
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
