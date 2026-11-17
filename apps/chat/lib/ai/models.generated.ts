import type { AiGatewayModel } from "@/lib/ai/ai-gateway-models-schemas";
import type { GatewayType } from "@/lib/ai/gateways/registry";

export const generatedForGateway = "anthropic" satisfies GatewayType;

export const models = [
  {
    "id": "claude-opus-5-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Opus 5.5",
    "description": "The current Opus, for demanding reasoning and long-horizon work. The phase gate's judge in this app. Thinking is always on; effort sets its depth.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000004",
      "output": "0.00002",
      "input_cache_read": "0.0000002",
      "input_cache_write": "0.000005",
      "web_search": "10"
    }
  },
  {
    "id": "claude-sonnet-5-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Sonnet 5.5",
    "description": "The current Sonnet: frontier capability at mid-tier cost and latency. The default chat model for this app.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000002",
      "output": "0.00001",
      "input_cache_read": "0.0000001",
      "input_cache_write": "0.0000025",
      "web_search": "10"
    }
  },
  {
    "id": "claude-haiku-5-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Haiku 5.5",
    "description": "The current Haiku: fast and low-cost, for titles, fact extraction, the research loop and other background workflows.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.0000001",
      "output": "0.0000005",
      "input_cache_read": "0.00000001",
      "input_cache_write": "0.000000125",
      "web_search": "10",
      "input_tiers": [
        {
          "cost": "0.0000001",
          "min": 0,
          "max": 100000
        },
        {
          "cost": "0.0000005",
          "min": 100000
        }
      ],
      "output_tiers": [
        {
          "cost": "0.0000005",
          "min": 0,
          "max": 100000
        },
        {
          "cost": "0.0000025",
          "min": 100000
        }
      ]
    }
  },
  {
    "id": "claude-opus-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Opus 5",
    "description": "Anthropic's flagship Opus model for demanding reasoning, coding and long-horizon agentic work. Adaptive thinking is on by default.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000005",
      "output": "0.000025",
      "input_cache_read": "0.0000005",
      "input_cache_write": "0.00000625",
      "web_search": "10"
    }
  },
  {
    "id": "claude-fable-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Fable 5",
    "description": "Anthropic's most capable widely released model, for the hardest reasoning and long-horizon agentic tasks. Thinking is always on.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.00001",
      "output": "0.00005",
      "input_cache_read": "0.000001",
      "input_cache_write": "0.0000125",
      "web_search": "10"
    }
  },
  {
    "id": "claude-opus-4-8",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Opus 4.8",
    "description": "Opus-tier model for complex coding and agentic workflows, with the same request surface as Opus 4.7.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000005",
      "output": "0.000025",
      "input_cache_read": "0.0000005",
      "input_cache_write": "0.00000625",
      "web_search": "10"
    }
  },
  {
    "id": "claude-opus-4-7",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Opus 4.7",
    "description": "Opus-tier model for complex coding, agentic workflows and knowledge work.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000005",
      "output": "0.000025",
      "input_cache_read": "0.0000005",
      "input_cache_write": "0.00000625",
      "web_search": "10"
    }
  },
  {
    "id": "claude-opus-4-6",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Opus 4.6",
    "description": "Opus-tier model for coding and professional work across the whole software lifecycle.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000005",
      "output": "0.000025",
      "input_cache_read": "0.0000005",
      "input_cache_write": "0.00000625",
      "web_search": "10"
    }
  },
  {
    "id": "claude-opus-4-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Opus 4.5",
    "description": "Opus-tier model for demanding reasoning and complex problem solving, with strong tool and computer use.",
    "context_window": 200000,
    "max_tokens": 64000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000005",
      "output": "0.000025",
      "input_cache_read": "0.0000005",
      "input_cache_write": "0.00000625"
    }
  },
  {
    "id": "claude-sonnet-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Sonnet 5",
    "description": "The previous Sonnet, balancing frontier capability with cost and latency.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000002",
      "output": "0.00001",
      "input_cache_read": "0.0000002",
      "input_cache_write": "0.0000025",
      "web_search": "10"
    }
  },
  {
    "id": "claude-sonnet-4-6",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Sonnet 4.6",
    "description": "Sonnet-class model for iterative development, codebase navigation and polished document creation.",
    "context_window": 1000000,
    "max_tokens": 128000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000003",
      "output": "0.000015",
      "input_cache_read": "0.0000003",
      "input_cache_write": "0.00000375",
      "web_search": "10"
    }
  },
  {
    "id": "claude-sonnet-4-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Sonnet 4.5",
    "description": "Sonnet-class model balancing capability and cost for everyday chat and tool use.",
    "context_window": 1000000,
    "max_tokens": 64000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000003",
      "output": "0.000015",
      "input_cache_read": "0.0000003",
      "input_cache_write": "0.00000375",
      "web_search": "10"
    }
  },
  {
    "id": "claude-haiku-4-5",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Haiku 4.5",
    "description": "Fast, low-cost model for titles, suggestions and other high-volume background workflows.",
    "context_window": 200000,
    "max_tokens": 64000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000001",
      "output": "0.000005",
      "input_cache_read": "0.0000001",
      "input_cache_write": "0.00000125",
      "web_search": "10"
    }
  },
  {
    "id": "claude-haiku-4-5-20251001",
    "object": "model",
    "created": 1755815280,
    "owned_by": "anthropic",
    "name": "Claude Haiku 4.5 (2025-10-01)",
    "description": "Pinned snapshot of Claude Haiku 4.5. Use it when you need the model version to stay frozen.",
    "context_window": 200000,
    "max_tokens": 64000,
    "type": "language",
    "tags": [
      "file-input",
      "reasoning",
      "tool-use",
      "vision"
    ],
    "pricing": {
      "input": "0.000001",
      "output": "0.000005",
      "input_cache_read": "0.0000001",
      "input_cache_write": "0.00000125",
      "web_search": "10"
    }
  }
] as const satisfies readonly AiGatewayModel[];
