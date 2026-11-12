#!/usr/bin/env bun
/**
 * Build-time config validation script.
 * Validates that enabled features in config have their required env vars.
 * Run via `bun run check-env` or automatically in prebuild.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvConfig } from "dotenv";
import { getProvider } from "files-sdk/providers";
// biome-ignore lint/performance/noNamespaceImport: TypeScript API requires namespace import due to extensive usage
import * as ts from "typescript";
import type { GatewayType } from "../lib/ai/gateways/registry";
import { generatedForGateway } from "../lib/ai/models.generated";
import { config } from "../lib/config";
import {
  aiToolEnvRequirements,
  authEnvRequirements,
  gatewayEnvRequirements,
  getMissingDeepResearchBackend,
  getMissingRequirement,
  isRequirementSatisfied,
} from "../lib/config-requirements";
import { isPlaywrightTestEnvironment } from "../lib/playwright-test-environment";
import { storageProvider } from "../lib/storage-provider";
import {
  getStorageEnvironmentRequirements,
  type StorageEnvironmentVariable,
} from "../lib/storage-provider-metadata";

// apps/chat has no .env.local of its own — the real one lives at the repo root.
// Load it first so this script sees the same environment the dev server does.
loadEnvConfig({ path: path.resolve(process.cwd(), "../../.env.local") });
loadEnvConfig({ path: ".env.local" });
loadEnvConfig();

/**
 * `--dev` downgrades every validation failure to a warning. `bun run dev:local`
 * passes it so the app still boots with no AI provider key and no OAuth app at
 * all; `prebuild` does not, so production builds stay strict.
 */
const isDevMode = process.argv.includes("--dev");

interface ValidationError {
  feature: string;
  missing: string[];
}

/** Non-fatal notices collected during validation and printed at the end. */
const authWarnings: string[] = [];

type StaticToolEnvVar = {
  description?: string;
  options: string[][];
};

type StaticToolEnvVars = StaticToolEnvVar[];

type StaticToolMetadata = {
  toolEnvVars: StaticToolEnvVars;
};

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function unwrapExpression(node: ts.Expression): ts.Expression {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return unwrapExpression(node.expression);
  }
  return node;
}

function readString(node: ts.Expression): string | null {
  const expr = unwrapExpression(node);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  return null;
}

function readStringArray(node: ts.Expression): string[] | null {
  const expr = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(expr)) {
    return null;
  }

  const values: string[] = [];
  for (const element of expr.elements) {
    if (!ts.isExpression(element)) {
      return null;
    }
    const value = readString(element);
    if (value === null) {
      return null;
    }
    values.push(value);
  }

  return values;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: AST traversal logic is inherently complex
function readToolEnvVar(node: ts.Expression): StaticToolEnvVar | null {
  const expr = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(expr)) {
    return null;
  }

  let description: string | null = null;
  let options: string[][] | null = null;

  for (const property of expr.properties) {
    if (!ts.isPropertyAssignment(property)) {
      return null;
    }

    const nameNode = property.name;
    const name =
      ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)
        ? nameNode.text
        : null;

    if (name === "description") {
      description = readString(property.initializer);
    } else if (name === "options") {
      const outer = unwrapExpression(property.initializer);
      if (!ts.isArrayLiteralExpression(outer)) {
        return null;
      }

      const groups: string[][] = [];
      for (const element of outer.elements) {
        if (!ts.isExpression(element)) {
          return null;
        }
        const group = readStringArray(element);
        if (group === null) {
          return null;
        }
        groups.push(group);
      }
      options = groups;
    }
  }

  return options ? { ...(description ? { description } : {}), options } : null;
}

function readToolEnvVars(node: ts.Expression): StaticToolEnvVars {
  const expr = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(expr)) {
    return [];
  }

  const toolEnvVars: StaticToolEnvVars = [];
  for (const element of expr.elements) {
    if (!ts.isExpression(element)) {
      return [];
    }
    const toolEnvVar = readToolEnvVar(element);
    if (!toolEnvVar) {
      return [];
    }
    toolEnvVars.push(toolEnvVar);
  }

  return toolEnvVars;
}

function readStaticToolMetadata(sourceText: string): StaticToolMetadata {
  const sourceFile = ts.createSourceFile(
    "tool.ts",
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
  const toolEnvVars: StaticToolEnvVars = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.name.getText() !== "toolEnvVars") {
          continue;
        }
        const initializer = declaration.initializer;
        if (initializer && ts.isExpression(initializer)) {
          toolEnvVars.push(...readToolEnvVars(initializer));
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    toolEnvVars,
  };
}

function resolveToolsDir(toolsPath: string): string {
  if (toolsPath.startsWith("@/")) {
    return path.resolve(projectRoot, toolsPath.slice(2));
  }

  if (toolsPath.startsWith("./") || toolsPath.startsWith("../")) {
    return path.resolve(projectRoot, toolsPath);
  }

  if (path.isAbsolute(toolsPath)) {
    return toolsPath;
  }

  return path.resolve(projectRoot, toolsPath);
}

function validateGatewayKey(env: NodeJS.ProcessEnv): ValidationError | null {
  // Prevent TS from narrowing to the current literal config value.
  const gateway = (() => config.ai.gateway as GatewayType)();
  const requirement = gatewayEnvRequirements[gateway];
  const missing = getMissingRequirement(requirement, env);
  if (!missing) {
    return null;
  }
  return {
    feature: `aiGateway (${gateway})`,
    missing: [missing],
  };
}

function hasStorageEnvVariable(
  variable: StorageEnvironmentVariable,
  env: NodeJS.ProcessEnv
) {
  return [variable.key, ...(variable.aliases ?? [])].some((key) => !!env[key]);
}

function validateStorage(env: NodeJS.ProcessEnv): ValidationError | null {
  const enabled =
    config.features.attachments ||
    config.ai.tools.image.enabled ||
    config.ai.tools.video.enabled;
  if (!enabled) {
    return null;
  }

  const metadata = getProvider(storageProvider.slug);
  if (!metadata) {
    return {
      feature: "fileStorage",
      missing: [`Unknown Files SDK provider: ${storageProvider.slug}`],
    };
  }

  try {
    storageProvider.createAdapter();
  } catch (error) {
    return {
      feature: `fileStorage (${metadata.name})`,
      missing: [
        error instanceof Error ? error.message : "Invalid adapter options",
      ],
    };
  }

  const missing = getStorageEnvironmentRequirements(
    storageProvider.slug,
    storageProvider.options
  )
    .filter(
      (requirement) =>
        !requirement.options.some((option) =>
          option.every((variable) => hasStorageEnvVariable(variable, env))
        )
    )
    .map((requirement) =>
      requirement.options
        .map((option) => option.map(({ key }) => key).join(" + "))
        .join(" or ")
    );

  return missing.length > 0
    ? { feature: `fileStorage (${metadata.name})`, missing }
    : null;
}

function validateAiTools(env: NodeJS.ProcessEnv): ValidationError[] {
  const errors: ValidationError[] = [];

  const toolEntries = Object.entries(aiToolEnvRequirements) as [
    keyof typeof aiToolEnvRequirements,
    NonNullable<
      (typeof aiToolEnvRequirements)[keyof typeof aiToolEnvRequirements]
    >,
  ][];

  for (const [tool, requirement] of toolEntries) {
    const toolConfig = config.ai.tools[tool];
    if (!(requirement && "enabled" in toolConfig && toolConfig.enabled)) {
      continue;
    }
    const missing = getMissingRequirement(requirement, env);
    if (missing) {
      errors.push({
        feature: `ai.tools.${tool}`,
        missing: [missing],
      });
    }
  }

  // Not in the table above: its backend can be a config key, not only a variable.
  const deepResearch = config.ai.tools.deepResearch;
  if (deepResearch.enabled) {
    const missing = getMissingDeepResearchBackend(deepResearch, env);
    if (missing) {
      errors.push({ feature: "ai.tools.deepResearch", missing: [missing] });
    }
  }

  return errors;
}

function validateAuthentication(env: NodeJS.ProcessEnv): ValidationError[] {
  const errors: ValidationError[] = [];

  const authKeys = Object.keys(authEnvRequirements) as Array<
    keyof typeof authEnvRequirements
  >;
  for (const provider of authKeys) {
    if (!config.authentication[provider]) {
      continue;
    }
    const requirement = authEnvRequirements[provider];
    const missing = getMissingRequirement(requirement, env);
    if (missing) {
      errors.push({
        feature: `authentication.${provider}`,
        missing: [missing],
      });
    }
  }

  const hasAuth = authKeys.some((provider) => {
    if (!config.authentication[provider]) {
      return false;
    }
    return isRequirementSatisfied(authEnvRequirements[provider], env);
  });

  if (!hasAuth) {
    // Outside production this is not fatal: development has GET /api/dev-login
    // and dev email+password sign-in, neither of which needs an OAuth app.
    const message = {
      feature: "authentication",
      missing: ["At least one auth provider must be enabled and configured"],
    };
    if (isProductionEnvironment(env)) {
      errors.push(message);
    } else {
      authWarnings.push(
        "No social auth provider is enabled in chat.config.ts. In development, sign in at /api/dev-login (see GETTING-STARTED.md)."
      );
    }
  }

  return errors;
}

async function validateInstalledTools(
  env: NodeJS.ProcessEnv
): Promise<ValidationError[]> {
  const toolsDir = resolveToolsDir(config.paths.tools);
  const entries = await fs
    .readdir(toolsDir, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const errors: ValidationError[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) {
      continue;
    }

    const toolPath = path.join(toolsDir, entry.name, "tool.ts");
    const exists = await fs
      .access(toolPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      continue;
    }

    const toolSource = await fs.readFile(toolPath, "utf8");
    const mod = readStaticToolMetadata(toolSource);

    for (const toolEnvVar of mod.toolEnvVars) {
      const missing = getMissingRequirement(toolEnvVar, env);
      if (missing) {
        errors.push({
          feature: `tools.${entry.name}`,
          missing: [missing],
        });
      }
    }
  }

  return errors;
}

function isProductionEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.VERCEL === "1";
}

function validateBaseUrl(env: NodeJS.ProcessEnv): ValidationError | null {
  if (!isProductionEnvironment(env)) {
    return null;
  }

  const hasBaseUrl = !!(env.APP_URL || env.VERCEL_URL);
  if (hasBaseUrl) {
    return null;
  }

  return {
    feature: "baseUrl",
    missing: [
      "APP_URL (for non-Vercel deployments) or VERCEL_URL (auto on Vercel)",
    ],
  };
}

function checkGatewaySnapshot(): string | null {
  if ((config.ai.gateway as GatewayType) === generatedForGateway) {
    return null;
  }
  return `models.generated.ts was built for "${generatedForGateway}" but config uses "${config.ai.gateway}". Run \`bun fetch:models\` to update the fallback snapshot.`;
}

async function checkEnv(): Promise<void> {
  const env = process.env;
  if (isPlaywrightTestEnvironment(env)) {
    console.log(
      "✅ Skipping optional environment validation in Playwright test mode"
    );
    // Playwright CI only exercises anonymous flows, so optional feature checks
    // and the gateway snapshot warning stay enforced in non-Playwright builds.
    return;
  }

  const baseUrlError = validateBaseUrl(env);
  const gatewayError = validateGatewayKey(env);
  const storageError = validateStorage(env);
  const installedToolErrors = await validateInstalledTools(env);
  const errors = [
    ...(baseUrlError ? [baseUrlError] : []),
    ...(gatewayError ? [gatewayError] : []),
    ...(storageError ? [storageError] : []),
    ...validateAiTools(env),
    ...validateAuthentication(env),
    ...installedToolErrors,
  ];

  if (errors.length > 0) {
    const message = errors
      .map((e) => `  - ${e.feature}: ${e.missing.join(", ")}`)
      .join("\n");

    if (isDevMode) {
      console.warn(
        `⚠️  Environment validation found gaps (continuing — --dev):\n${message}\n\nThe app boots; features needing these vars stay unavailable until you set them.`
      );
    } else {
      console.error(
        `❌ Environment validation failed:\n${message}\n\nEither set the env vars or disable the feature in chat.config.ts`
      );
      process.exit(1);
    }
  }

  for (const warning of authWarnings) {
    console.warn(`⚠️  ${warning}`);
  }

  const snapshotWarning = checkGatewaySnapshot();
  if (snapshotWarning) {
    console.warn(`⚠️  ${snapshotWarning}`);
  }

  console.log(
    errors.length > 0
      ? "✅ Environment validation finished with warnings"
      : "✅ Environment validation passed"
  );
}

checkEnv().catch((error) => {
  console.error(error);
  process.exit(1);
});
