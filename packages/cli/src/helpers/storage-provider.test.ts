import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	configureStorageProvider,
	getProviderFactoryName,
	INSTALLABLE_STORAGE_PROVIDERS,
	parseStorageOptions,
	resolveStorageProvider,
	storageEnvRequirements,
} from "./storage-provider";
import { promptStorage } from "./prompts";

describe("storage provider configuration", () => {
	it("accepts every provider compatible with a generated Next.js app", () => {
		for (const provider of INSTALLABLE_STORAGE_PROVIDERS) {
			expect(resolveStorageProvider(provider)).toBe(provider);
		}
		expect(() => resolveStorageProvider("bun-s3")).toThrow(
			'Provider "bun-s3" is not supported',
		);
		expect(() => resolveStorageProvider("convex")).toThrow(
			'Provider "convex" is not supported',
		);
		expect(() => resolveStorageProvider("memory")).toThrow(
			'Provider "memory" is not supported',
		);
		expect(() => resolveStorageProvider("fs")).toThrow(
			'Provider "fs" is not supported',
		);
		expect(() => resolveStorageProvider("box")).toThrow(
			'Provider "box" is not supported',
		);
		expect(() => resolveStorageProvider("not-a-provider")).toThrow("Unknown");
	});

	it("derives an exported factory for every installable provider", async () => {
		const filesSdkDist = dirname(
			fileURLToPath(import.meta.resolve("files-sdk")),
		);
		for (const provider of INSTALLABLE_STORAGE_PROVIDERS) {
			const factory = getProviderFactoryName(provider);
			const declarations = await readFile(
				join(filesSdkDist, provider, "index.d.ts"),
				"utf8",
			);
			expect(
				declarations.includes(`const ${factory}`) ||
					declarations.includes(`as ${factory}`),
			).toBe(true);
		}
	});

	it("does not require credentials resolved by a provider SDK chain", () => {
		expect(storageEnvRequirements("s3")).toEqual([
			{
				description: "S3 configuration",
				options: [["AWS_REGION"]],
			},
		]);
		expect(storageEnvRequirements("gcs")).toEqual([]);
		expect(storageEnvRequirements("s3", { region: "us-east-1" })).toEqual([]);
	});

	it("parses adapter options as an object", () => {
		expect(parseStorageOptions('{"bucket":"uploads"}')).toEqual({
			bucket: "uploads",
		});
		expect(() => parseStorageOptions("[]")).toThrow("JSON object");
	});

	it("rejects explicitly empty storage config", async () => {
		await expect(promptStorage(true, "vercel-blob", "")).rejects.toThrow(
			"valid JSON object",
		);
	});

	it("derives Vercel Blob credential alternatives from the catalog", () => {
		expect(storageEnvRequirements("vercel-blob")).toEqual([
			{
				description: "Vercel Blob credentials",
				options: [
					["BLOB_READ_WRITE_TOKEN"],
					["VERCEL_OIDC_TOKEN", "BLOB_STORE_ID"],
				],
			},
		]);
	});

	it("requires R2 env credentials unless a binding is configured", () => {
		expect(storageEnvRequirements("r2")).toEqual([
			{
				description: "Cloudflare R2 credentials",
				options: [["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]],
			},
		]);
		expect(storageEnvRequirements("r2", { binding: {} })).toEqual([]);
	});

	it("configures repositories without an env example", async () => {
		const destination = await mkdtemp(join(tmpdir(), "chat-js-storage-no-env-"));
		try {
			await mkdir(join(destination, "lib"));
			await writeFile(
				join(destination, "package.json"),
				JSON.stringify({ dependencies: { "files-sdk": "2.1.0" } }),
			);
			await writeFile(
				join(destination, "lib", "storage-provider.ts"),
				'import { memory } from "files-sdk/memory";\n',
			);

			await configureStorageProvider(destination, {
				provider: "vercel-blob",
				options: {},
			});

			expect(
				await readFile(join(destination, "lib", "storage-provider.ts"), "utf8"),
			).toContain('from "files-sdk/vercel-blob"');
		} finally {
			await rm(destination, { recursive: true, force: true });
		}
	});

	it("removes only dependencies owned by the previous storage provider", async () => {
		const destination = await mkdtemp(join(tmpdir(), "chat-js-storage-"));
		try {
			await mkdir(join(destination, "lib"));
			await writeFile(
				join(destination, "package.json"),
				JSON.stringify({
					dependencies: {
						"@google-cloud/storage": "^7.19.0",
						"@vercel/blob": "2.4.0",
						"files-sdk": "2.1.0",
					},
				}),
			);
			await writeFile(
				join(destination, "lib", "storage-provider.ts"),
				'// ChatJS storage peer dependencies: ["@vercel/blob"]\nimport { vercelBlob } from "files-sdk/vercel-blob";\n',
			);
			await writeFile(
				join(destination, ".env.example"),
				"# <chatjs-storage-provider>\n# </chatjs-storage-provider>\n",
			);

			await configureStorageProvider(destination, {
				provider: "s3",
				options: { bucket: "uploads", region: "us-east-1" },
			});

			const packageJson = JSON.parse(
				await readFile(join(destination, "package.json"), "utf8"),
			) as { dependencies: Record<string, string> };
			expect(packageJson.dependencies["@vercel/blob"]).toBeUndefined();
			expect(packageJson.dependencies["@google-cloud/storage"]).toBe("^7.19.0");
			expect(packageJson.dependencies["@aws-sdk/client-s3"]).toBe("^3.700.0");
			const providerSource = await readFile(
				join(destination, "lib", "storage-provider.ts"),
				"utf8",
			);
			expect(providerSource).toContain("satisfies Parameters<typeof s3>[0]");
			const envExample = await readFile(
				join(destination, ".env.example"),
				"utf8",
			);
			expect(envExample).not.toContain("AWS_REGION");
		} finally {
			await rm(destination, { recursive: true, force: true });
		}
	});

	it("preserves provider peers not marked as generator-owned", async () => {
		const destination = await mkdtemp(join(tmpdir(), "chat-js-storage-owned-"));
		try {
			await mkdir(join(destination, "lib"));
			await writeFile(
				join(destination, "package.json"),
				JSON.stringify({
					dependencies: {
						"@vercel/blob": "2.4.0",
						"files-sdk": "2.1.0",
					},
				}),
			);
			await writeFile(
				join(destination, "lib", "storage-provider.ts"),
				'import { vercelBlob } from "files-sdk/vercel-blob";\n',
			);

			await configureStorageProvider(destination, {
				provider: "s3",
				options: { bucket: "uploads", region: "us-east-1" },
			});

			const packageJson = JSON.parse(
				await readFile(join(destination, "package.json"), "utf8"),
			) as { dependencies: Record<string, string> };
			expect(packageJson.dependencies["@vercel/blob"]).toBe("2.4.0");
		} finally {
			await rm(destination, { recursive: true, force: true });
		}
	});
});
