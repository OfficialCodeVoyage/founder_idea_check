import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";
import { encryptedJson, encryptedText } from "./encrypted-text";

export type User = InferSelectModel<typeof user>;

export const userCredit = pgTable("UserCredit", {
  userId: text("userId")
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Balance in cents. Default = $0.50 */
  credits: integer("credits").notNull().default(50),
});

export type UserCredit = InferSelectModel<typeof userCredit>;

export const userModelPreference = pgTable(
  "UserModelPreference",
  {
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    modelId: varchar("modelId", { length: 256 }).notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.modelId] }),
    UserModelPreference_user_id_idx: index(
      "UserModelPreference_user_id_idx"
    ).on(t.userId),
  })
);

export type UserModelPreference = InferSelectModel<typeof userModelPreference>;

export const project = pgTable(
  "Project",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    instructions: text("instructions").notNull().default(""),
    icon: varchar("icon", { length: 64 }).notNull().default("folder"),
    iconColor: varchar("iconColor", { length: 32 }).notNull().default("gray"),
  },
  (t) => ({
    Project_user_id_idx: index("Project_user_id_idx").on(t.userId),
  })
);

export type Project = InferSelectModel<typeof project>;

export const chat = pgTable("Chat", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  createdAt: timestamp("createdAt").notNull(),
  updatedAt: timestamp("updatedAt")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  title: text("title").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
  visibility: varchar("visibility", { enum: ["public", "private"] })
    .notNull()
    .default("private"),
  isPinned: boolean("isPinned").notNull().default(false),
  projectId: uuid("projectId").references(() => project.id, {
    onDelete: "set null",
  }),
});

export type Chat = InferSelectModel<typeof chat>;

export const message = pgTable("Message", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id, {
      onDelete: "cascade",
    }),
  parentMessageId: uuid("parentMessageId"),
  role: varchar("role").notNull(),
  // parts column removed - parts are now stored in Part table
  attachments: json("attachments").notNull(),
  createdAt: timestamp("createdAt").notNull(),
  annotations: json("annotations"),
  selectedModel: json("selectedModel"),
  selectedTool: varchar("selectedTool", { length: 256 }).default(""),
  parallelGroupId: uuid("parallelGroupId"),
  parallelIndex: integer("parallelIndex"),
  isPrimaryParallel: boolean("isPrimaryParallel"),
  lastContext: json("lastContext"),
  activeStreamId: varchar("activeStreamId", { length: 64 }),
  /** Timestamp when this message's stream was canceled by the user. Null means not canceled. */
  canceledAt: timestamp("canceledAt"),
});

export type DBMessage = InferSelectModel<typeof message>;

/**
 * Prefix-based Part Storage
 *
 * This table replaces the JSON `Message.parts` column with a normalized,
 * prefix-based column structure. Each row represents a single message part.
 *
 * Rationale:
 * - Type safety: Strongly-typed columns instead of flexible JSONB
 * - Data integrity: Database-level check constraints ensure valid part data
 * - Query performance: Direct column access with proper indexes
 * - Migration-friendly: Schema changes can be applied incrementally
 * - Extensibility: New part types can be added via new columns with prefixes
 *
 * Prefix Convention:
 * - text_*: Text content parts
 * - reasoning_*: Reasoning/thinking parts
 * - file_*: File attachments
 * - source_url_*: URL sources
 * - source_document_*: Document sources
 * - tool_*: Tool calls (generic for all tool-[name] parts)
 * - data_*: Custom data parts (generic bucket for all data-[type] parts)
 *
 */
export const part = pgTable(
  "Part",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    messageId: uuid("messageId")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    order: integer("order").notNull().default(0),
    type: varchar("type").notNull(),
    // Text fields
    text_text: text("text_text"),
    // Reasoning fields
    reasoning_text: text("reasoning_text"),
    // File fields
    file_mediaType: varchar("file_mediaType"),
    file_filename: varchar("file_filename"),
    file_url: varchar("file_url"),
    // Source URL fields
    source_url_sourceId: varchar("source_url_sourceId"),
    source_url_url: varchar("source_url_url"),
    source_url_title: varchar("source_url_title"),
    // Source Document fields
    source_document_sourceId: varchar("source_document_sourceId"),
    source_document_mediaType: varchar("source_document_mediaType"),
    source_document_title: varchar("source_document_title"),
    source_document_filename: varchar("source_document_filename"),
    // Tool fields (generic for all tool-* parts)
    tool_name: varchar("tool_name"),
    tool_toolCallId: varchar("tool_toolCallId"),
    tool_state: varchar("tool_state"),
    tool_input: json("tool_input"),
    tool_output: json("tool_output"),
    tool_errorText: varchar("tool_errorText"),
    // Data fields (generic bucket for all data-* parts)
    data_type: varchar("data_type"),
    data_blob: json("data_blob"),
    // Provider metadata
    providerMetadata: json("providerMetadata"),
  },
  (t) => ({
    Part_message_id_idx: index("Part_message_id_idx").on(t.messageId),
    Part_message_id_order_idx: index("Part_message_id_order_idx").on(
      t.messageId,
      t.order
    ),
    text_chk: check(
      "Part_text_required_if_type_text",
      sql`CASE WHEN ${t.type} = 'text' THEN ${t.text_text} IS NOT NULL ELSE TRUE END`
    ),
    reasoning_chk: check(
      "Part_reasoning_required_if_type_reasoning",
      sql`CASE WHEN ${t.type} = 'reasoning' THEN ${t.reasoning_text} IS NOT NULL ELSE TRUE END`
    ),
    file_chk: check(
      "Part_file_required_if_type_file",
      sql`CASE WHEN ${t.type} = 'file' THEN ${t.file_mediaType} IS NOT NULL AND ${t.file_url} IS NOT NULL ELSE TRUE END`
    ),
    source_url_chk: check(
      "Part_source_url_required_if_type_source_url",
      sql`CASE WHEN ${t.type} = 'source-url' THEN ${t.source_url_sourceId} IS NOT NULL AND ${t.source_url_url} IS NOT NULL ELSE TRUE END`
    ),
    source_document_chk: check(
      "Part_source_document_required_if_type_source_document",
      sql`CASE WHEN ${t.type} = 'source-document' THEN ${t.source_document_sourceId} IS NOT NULL AND ${t.source_document_mediaType} IS NOT NULL AND ${t.source_document_title} IS NOT NULL ELSE TRUE END`
    ),
    tool_chk: check(
      "Part_tool_required_if_type_tool",
      sql`CASE WHEN ${t.type} LIKE 'tool-%' THEN ${t.tool_toolCallId} IS NOT NULL AND ${t.tool_state} IS NOT NULL ELSE TRUE END`
    ),
    data_chk: check(
      "Part_data_required_if_type_data",
      sql`CASE WHEN ${t.type} LIKE 'data-%' THEN ${t.data_type} IS NOT NULL ELSE TRUE END`
    ),
  })
);

export type Part = InferSelectModel<typeof part>;

export const vote = pgTable(
  "Vote",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id, {
        onDelete: "cascade",
      }),
    messageId: uuid("messageId")
      .notNull()
      .references(() => message.id, {
        onDelete: "cascade",
      }),
    isUpvoted: boolean("isUpvoted").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.messageId] }),
  })
);

export type Vote = InferSelectModel<typeof vote>;

export const document = pgTable(
  "Document",
  {
    id: uuid("id").notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull(),
    title: text("title").notNull(),
    content: text("content"),
    kind: varchar("kind", { enum: ["text", "code", "sheet", "persona"] })
      .notNull()
      .default("text"),
    userId: text("userId")
      .notNull()
      .references(() => user.id),
    /**
     * NULLABLE. A persona is regenerated from the fact store on demand, not
     * produced by one assistant turn, so there is no message to hang it on.
     *
     * READ-SIDE CONSEQUENCE: the public-visibility branches in queries.ts
     * derive visibility by joining Message -> Chat. A row with a NULL
     * messageId has no chat and therefore no public visibility path; those
     * queries return it to its owner only. See getDocumentsById.
     */
    messageId: uuid("messageId").references(() => message.id, {
      onDelete: "cascade",
    }),
    /** NULL for artifacts created outside a project. */
    projectId: uuid("projectId").references(() => project.id, {
      onDelete: "cascade",
    }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.createdAt] }),
    document_message_id_idx: index("Document_message_id_idx").on(
      table.messageId
    ),
    document_project_kind_idx: index("Document_project_kind_idx").on(
      table.projectId,
      table.kind
    ),
  })
);

export type Document = InferSelectModel<typeof document>;

export const suggestion = pgTable(
  "Suggestion",
  {
    id: uuid("id").notNull().defaultRandom(),
    documentId: uuid("documentId").notNull(),
    documentCreatedAt: timestamp("documentCreatedAt").notNull(),
    originalText: text("originalText").notNull(),
    suggestedText: text("suggestedText").notNull(),
    description: text("description"),
    isResolved: boolean("isResolved").notNull().default(false),
    userId: text("userId")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id] }),
    documentRef: foreignKey({
      columns: [table.documentId, table.documentCreatedAt],
      foreignColumns: [document.id, document.createdAt],
    }),
  })
);

export type Suggestion = InferSelectModel<typeof suggestion>;
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const mcpConnector = pgTable(
  "McpConnector",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: text("userId").references(() => user.id, { onDelete: "cascade" }), // null = global
    name: varchar("name", { length: 256 }).notNull(),
    nameId: varchar("nameId", { length: 256 }).notNull(), // unique per user, used as namespace for tool IDs
    url: encryptedText("url").notNull(),
    type: varchar("type", { enum: ["http", "sse"] })
      .notNull()
      .default("http"),
    oauthClientId: text("oauthClientId"),
    oauthClientSecret: encryptedText("oauthClientSecret"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    McpConnector_user_id_idx: index("McpConnector_user_id_idx").on(t.userId),
    McpConnector_user_name_id_idx: index("McpConnector_user_name_id_idx").on(
      t.userId,
      t.nameId
    ),
    McpConnector_user_name_id_unique: uniqueIndex(
      "McpConnector_user_name_id_unique"
    ).on(t.userId, t.nameId),
  })
);

export type McpConnector = InferSelectModel<typeof mcpConnector>;

export const mcpOAuthSession = pgTable(
  "McpOAuthSession",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    mcpConnectorId: uuid("mcpConnectorId")
      .notNull()
      .references(() => mcpConnector.id, { onDelete: "cascade" }),
    serverUrl: text("serverUrl").notNull(),
    clientInfo: encryptedJson<Record<string, unknown>>()("clientInfo"), // OAuthClientInformationFull from MCP SDK
    tokens: encryptedJson<Record<string, unknown>>()("tokens"), // OAuthTokens from MCP SDK
    codeVerifier: encryptedText("codeVerifier"), // PKCE verifier
    state: text("state").unique(), // OAuth state param (unique for security)
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    McpOAuthSession_connector_idx: index("McpOAuthSession_connector_idx").on(
      t.mcpConnectorId
    ),
    McpOAuthSession_state_idx: index("McpOAuthSession_state_idx").on(t.state),
  })
);

export type McpOAuthSession = InferSelectModel<typeof mcpOAuthSession>;

/**
 * Per-project state for one phase of the validation workflow.
 * One row per (projectId, phaseKey) — the unique index below is what makes
 * "re-run the gate" an UPDATE rather than an append-only log.
 */
export const projectPhase = pgTable(
  "ProjectPhase",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    phaseKey: varchar("phaseKey", { length: 64 }).notNull(),
    phaseOrder: integer("phaseOrder").notNull(),
    status: varchar("status", { enum: ["locked", "active", "passed"] })
      .notNull()
      .default("active"),
    /** Last gate verdict. NULL means the gate has never run for this phase. */
    decision: varchar("decision", { enum: ["PASS", "WARN", "BLOCK"] }),
    /** Deterministic one-line rationale built by decideGate(). */
    reason: text("reason"),
    /** The single question the founder should answer next; NULL on PASS. */
    nextQuestion: text("nextQuestion"),
    /** Full GateVerdict blob (perCriterion + missing), for the rail tooltip. */
    verdict: json("verdict"),
    /** How many times the gate has run for this phase (retry budget). */
    attemptCount: integer("attemptCount").notNull().default(0),
    evaluatedAt: timestamp("evaluatedAt"),
  },
  (t) => ({
    ProjectPhase_project_id_idx: index("ProjectPhase_project_id_idx").on(
      t.projectId
    ),
    ProjectPhase_project_phase_unique: uniqueIndex(
      "ProjectPhase_project_phase_unique"
    ).on(t.projectId, t.phaseKey),
  })
);

export type ProjectPhase = InferSelectModel<typeof projectPhase>;

/**
 * The project fact store. Written by the post-turn extraction pass, read back
 * into the system prompt of later phases.
 *
 * The unique index is (projectId, key) and deliberately does NOT include
 * phaseKey. A fact is identified by WHAT it says about the project, not by
 * where it was learned — so when a later phase revises `target_user`, the
 * phase-1 row is UPDATED, not shadowed by a duplicate. `phaseKey` is
 * provenance (which phase last wrote it), never identity. That is what makes
 * onConflictDoUpdate({ target: [projectId, key] }) the whole of the
 * insert-vs-update logic on the SQL side.
 */
export const projectFact = pgTable(
  "ProjectFact",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Phase that last wrote this fact — provenance, not identity. */
    phaseKey: varchar("phaseKey", { length: 64 }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    value: text("value").notNull(),
    /** 0-100 integer. Integer, not float, so equality/ordering are exact. */
    confidence: integer("confidence").notNull().default(50),
    /** The assistant message the fact came from. Survives its deletion. */
    sourceMessageId: uuid("sourceMessageId").references(() => message.id, {
      onDelete: "set null",
    }),
    extractedAt: timestamp("extractedAt").notNull().defaultNow(),

    /**
     * Semantic vector over "key: value", used to choose WHICH earlier facts get
     * injected into a later phase's prompt. Nullable on purpose: a fact whose
     * embedding call failed must still be a fact, and the keyword selector
     * still ranks it. Never let an embedding failure make a fact invisible.
     *
     * WIDTH IS A SCHEMA DECISION, not a model one. 1536 = text-embedding-3-small,
     * and it is the largest width pgvector will actually INDEX — hnsw/ivfflat
     * cap at 2000 dimensions (verified live against pgvector 0.8.6:
     * "column cannot have more than 2000 dimensions for hnsw index"). That is
     * why text-embedding-3-large's native 3072 is not an option; the upgrade
     * path is 3-large with dimensions:1536, which is a re-embed, not a
     * migration. See DATA-LAYER.md.
     */
    embedding: vector("embedding", { dimensions: 1536 }),
    /**
     * WHICH model produced `embedding`, and at what width. Stored per row, not
     * inferred from config, so that (a) a re-embed after a model change is
     * incremental — find the rows whose model differs — and (b) a mismatch is
     * DETECTABLE rather than silently producing meaningless cosine distances
     * between two different vector spaces.
     */
    embeddingModel: varchar("embeddingModel", { length: 128 }),
    embeddingDims: integer("embeddingDims"),
    embeddedAt: timestamp("embeddedAt"),
  },
  (t) => ({
    ProjectFact_project_id_idx: index("ProjectFact_project_id_idx").on(
      t.projectId
    ),
    ProjectFact_project_key_unique: uniqueIndex(
      "ProjectFact_project_key_unique"
    ).on(t.projectId, t.key),
    /**
     * Cosine, matching the distance function the selector uses. An HNSW index
     * over a mostly-NULL column is harmless — pgvector skips NULLs — so this is
     * safe to create before anything is embedded.
     */
    ProjectFact_embedding_idx: index("ProjectFact_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops")
    ),
    confidence_chk: check(
      "ProjectFact_confidence_range",
      sql`${t.confidence} BETWEEN 0 AND 100`
    ),
    /**
     * The vector space is only coherent if every row in it came from the same
     * model at the same width. This makes "embedding present but unlabelled"
     * — the state that silently poisons a similarity search — unrepresentable.
     */
    embedding_labelled_chk: check(
      "ProjectFact_embedding_labelled",
      sql`(${t.embedding} IS NULL) = (${t.embeddingModel} IS NULL)
          AND (${t.embedding} IS NULL) = (${t.embeddingDims} IS NULL)`
    ),
  })
);

export type ProjectFact = InferSelectModel<typeof projectFact>;

/**
 * Founder-owned state for one unblocking task.
 *
 * `taskId` is the DETERMINISTIC id built by lib/ultraplan/blockers.ts
 * (`${phaseKey}::${criterionId}::${kind}`), not a uuid — that is what lets a
 * re-run of the gate reconcile with what the founder already ticked instead of
 * producing a second row for the same work.
 *
 * The title/detail/producesFactKey columns are a SNAPSHOT, so a task whose
 * blocker no longer appears in the current verdict can still be rendered
 * (reconcileTasks() flags it `orphaned` rather than deleting or completing it).
 */
export const projectTask = pgTable(
  "ProjectTask",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** `${phaseKey}::${criterionId}::${kind}` from UnblockingTask.id. */
    taskId: varchar("taskId", { length: 256 }).notNull(),
    phaseKey: varchar("phaseKey", { length: 64 }).notNull(),
    criterionId: varchar("criterionId", { length: 64 }).notNull(),
    /**
     * NOTE: "unknown" is deliberately NOT in this enum. It is the read-side
     * fail-closed value produced by parseTaskState() when a stored string is
     * unrecognised; writing it back would persist a parse failure as if it were
     * a decision.
     */
    state: varchar("state", {
      enum: ["todo", "active", "blocked", "done", "dropped"],
    })
      .notNull()
      .default("todo"),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    producesFactKey: varchar("producesFactKey", { length: 128 }),
  },
  (t) => ({
    ProjectTask_project_id_idx: index("ProjectTask_project_id_idx").on(
      t.projectId
    ),
    ProjectTask_project_task_unique: uniqueIndex(
      "ProjectTask_project_task_unique"
    ).on(t.projectId, t.taskId),
  })
);

export type ProjectTask = InferSelectModel<typeof projectTask>;

/**
 * A simulation persona (Step 8). DISTINCT from the Document-backed persona
 * artifact of Step 6: that one is the founder's single evidenced customer
 * profile and is versioned through Document's composite key; these are the
 * population an OASIS run is seeded with, and they are disposable per run.
 */
export const projectPersona = pgTable(
  "ProjectPersona",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    headline: text("headline").notNull(),
    description: text("description").notNull(),
    age: integer("age").notNull(),
    gender: text("gender").notNull(),
    country: text("country").notNull(),
    mbti: text("mbti"),
    /** MANDATORY. A persona with no evidence is a character, not a finding. */
    evidence: jsonb("evidence")
      .$type<{ url: string; quote: string }[]>()
      .notNull(),
  },
  (t) => ({
    ProjectPersona_project_id_idx: index("ProjectPersona_project_id_idx").on(
      t.projectId
    ),
  })
);

export type ProjectPersona = InferSelectModel<typeof projectPersona>;

/**
 * One OASIS simulation run.
 *
 * STORE COLLAPSED RUNS. A run whose personas all agreed is the most
 * interesting diagnostic there is — it usually means the personas were seeded
 * from too few facts — and deleting it hides the pattern. `usable: false` is a
 * finding, not a reason to drop the row.
 */
export const simulationRun = pgTable(
  "SimulationRun",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    projectId: uuid("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    pitch: text("pitch").notNull(),
    /** Full DivergenceReport. Store it even when the run collapsed. */
    divergence: jsonb("divergence").notNull(),
    /** False for a collapsed run. NOT a reason to delete the row. */
    usable: boolean("usable").notNull(),
    reactions: jsonb("reactions").notNull(),
  },
  (t) => ({
    SimulationRun_project_id_idx: index("SimulationRun_project_id_idx").on(
      t.projectId
    ),
  })
);

export type SimulationRun = InferSelectModel<typeof simulationRun>;

export const schema = { user, session, account, verification };
