import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEnvChecklist } from "./env-checklist";
import { buildConfigTs } from "./config-builder";
import { fetchRegistryIndex } from "../registry/fetch";
import { resolveRegistryItems } from "../registry/resolve";
import { installRegistryTools } from "../utils/install-registry-tools";
import { GATEWAYS, type BuiltInToolKey, type Gateway } from "../types";

const localRegistryUrl = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../registry/items/{name}.json",
);

const tempDirs: string[] = [];

async function makeTempDir(name: string): Promise<string> {
	const dir = join(
		tmpdir(),
		`chat-js-scaffold-contract-${name}-${crypto.randomUUID()}`,
	);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function buildConfigFor(
	gateway: Gateway,
	builtInTools: Record<BuiltInToolKey, boolean>,
) {
	return buildConfigTs({
		appName: "Contract Test",
		appPrefix: "contract-test",
		appUrl: "http://localhost:3000",
		withElectron: false,
		gateway,
		coreFeatures: {
			attachments: true,
			parallelResponses: true,
			documents: true,
			mcp: true,
			followupSuggestions: true,
		},
		documentTypes: {
			text: true,
			code: true,
			sheet: true,
		},
		builtInTools,
		auth: {
			google: true,
			github: true,
			vercel: true,
		},
	});
}

describe("scaffold contracts", () => {
	it("builds valid configs for the high-risk built-in tool matrix", () => {
		const allBuiltIns = {
			webSearch: true,
			urlRetrieval: true,
			deepResearch: true,
			codeExecution: true,
			imageGeneration: true,
			videoGeneration: true,
		} satisfies Record<BuiltInToolKey, boolean>;

		for (const gateway of GATEWAYS) {
			const output = buildConfigFor(gateway, allBuiltIns);
			expect(output).toContain(`gateway: ${JSON.stringify(gateway)}`);
		}

		const openaiCompatible = buildConfigFor("openai-compatible", allBuiltIns);
		expect(openaiCompatible).toContain('default: "gpt-image-1"');
		expect(openaiCompatible).toMatch(/video:\s*{\s*enabled:\s*false,/m);

		const litellm = buildConfigFor("litellm", allBuiltIns);
		expect(litellm).toContain('chat: "openai/gpt-4o-mini"');
		expect(litellm).toMatch(/image:\s*{\s*enabled:\s*false,/m);
		expect(litellm).toMatch(/video:\s*{\s*enabled:\s*false,/m);
	});

	it("resolves and injects every visible registry tool without scaffolding an app", async () => {
		const visibleTools = (await fetchRegistryIndex(localRegistryUrl))
			.filter((item) => !item.hidden)
			.map((item) => item.name);
		const cwd = await makeTempDir("registry");
		const toolsDir = join(cwd, "tools", "chatjs");

		await mkdir(cwd, { recursive: true });
		await writeFile(
			join(cwd, "package.json"),
			`${JSON.stringify({ name: "registry-contract", dependencies: {}, devDependencies: {} }, null, 2)}\n`,
		);

		const install = await installRegistryTools({
			tools: visibleTools,
			cwd,
			toolsDir,
			toolsAlias: "@/tools/chatjs",
			registryUrl: localRegistryUrl,
			installDependenciesNow: false,
			packageManager: "npm",
		});

		const packageJson = JSON.parse(
			await readFile(join(cwd, "package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
		};
		const toolsSource = await readFile(join(toolsDir, "tools.ts"), "utf8");
		const uiSource = await readFile(join(toolsDir, "ui.ts"), "utf8");
		const envEntries = collectEnvChecklist({
			gateway: "vercel",
			coreFeatures: {
				attachments: false,
				parallelResponses: true,
				documents: true,
				mcp: false,
				followupSuggestions: false,
			},
			builtInTools: {
				webSearch: false,
				urlRetrieval: false,
				deepResearch: false,
				codeExecution: false,
				imageGeneration: false,
				videoGeneration: false,
			},
			auth: {
				google: false,
				github: true,
				vercel: false,
			},
			installableToolEnvRequirements: install.envRequirements,
		});

		expect(packageJson.dependencies?.["@mendable/firecrawl-js"]).toBe("latest");
		expect(packageJson.dependencies?.["date-fns"]).toBe("latest");
		expect(toolsSource).toContain("getWeather");
		expect(toolsSource).toContain("wordCount");
		expect(toolsSource).toContain("retrieveUrl");
		expect(uiSource).toContain('"tool-getWeather"');
		expect(uiSource).toContain('"tool-wordCount"');
		expect(uiSource).toContain('"tool-retrieveUrl"');
		expect(envEntries.some((entry) => entry.vars === "FIRECRAWL_API_KEY")).toBe(
			true,
		);
	});

	it("requires shared registry dependencies when renderer files import shared toolkit code", async () => {
		const visibleTools = (await fetchRegistryIndex(localRegistryUrl))
			.filter((item) => !item.hidden)
			.map((item) => item.name);
		const resolution = await resolveRegistryItems(visibleTools, localRegistryUrl);

		for (const item of resolution.items) {
			const importsSharedToolkit = item.files.some((file) =>
				file.content.includes("@/tools/chatjs/_shared/"),
			);
			if (!(importsSharedToolkit && item.name !== "toolkit-renderer")) {
				continue;
			}

			expect(item.registryDependencies).toContain("toolkit-renderer");
		}
	});
});
