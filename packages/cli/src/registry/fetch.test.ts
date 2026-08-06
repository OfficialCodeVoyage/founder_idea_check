import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRegistryIndex, fetchRegistryItem } from "./fetch";

const tempDirs: string[] = [];

function makeTempDir(name: string): string {
	const dir = join(tmpdir(), `chat-js-registry-${name}-${crypto.randomUUID()}`);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("registry fetch", () => {
	it("loads a local root index from an items path template", async () => {
		const registryDir = makeTempDir("local");
		await mkdir(join(registryDir, "items"), { recursive: true });
		await writeFile(
			join(registryDir, "index.json"),
			JSON.stringify([{ name: "word-count", description: "Count words" }]),
		);
		await writeFile(
			join(registryDir, "items", "word-count.json"),
			JSON.stringify({
				name: "word-count",
				description: "Count words",
				files: [],
			}),
		);

		const registryUrl = join(registryDir, "items", "{name}.json");

		await expect(fetchRegistryIndex(registryUrl)).resolves.toEqual([
			{ name: "word-count", description: "Count words" },
		]);
		await expect(fetchRegistryItem("word-count", registryUrl)).resolves.toMatchObject({
			name: "word-count",
		});
	});

	it("treats normalized relative registry paths as local files", async () => {
		const tempParent = makeTempDir("relative");
		const registryDir = join(tempParent, "registry");
		const originalCwd = process.cwd();

		await mkdir(join(registryDir, "items"), { recursive: true });
		await writeFile(
			join(registryDir, "index.json"),
			JSON.stringify([{ name: "get-weather" }]),
		);

		process.chdir(tempParent);
		try {
			await expect(
				fetchRegistryIndex("registry/items/{name}.json"),
			).resolves.toEqual([{ name: "get-weather" }]);
		} finally {
			process.chdir(originalCwd);
		}
	});
});
