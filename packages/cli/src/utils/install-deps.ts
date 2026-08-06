import fs from "node:fs/promises";
import path from "node:path";
import type { PackageManager } from "../types";
import { inferPackageManager } from "./get-package-manager";
import { runCommand } from "./run-command";

async function updatePackageJsonDependencies(
	deps: string[],
	devDeps: string[],
	cwd: string,
): Promise<void> {
	const packageJsonPath = path.join(cwd, "package.json");
	const packageJson = JSON.parse(
		await fs.readFile(packageJsonPath, "utf8"),
	) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};

	packageJson.dependencies ??= {};
	packageJson.devDependencies ??= {};

	for (const dependency of deps) {
		packageJson.dependencies[dependency] ??= "latest";
	}

	for (const dependency of devDeps) {
		packageJson.devDependencies[dependency] ??= "latest";
	}

	await fs.writeFile(
		packageJsonPath,
		`${JSON.stringify(packageJson, null, 2)}\n`,
	);
}

/**
 * Install npm dependencies in `cwd` using the detected package manager.
 * If installNow is false, only update package.json.
 */
export async function installDependencies(
	deps: string[],
	devDeps: string[],
	cwd: string,
	installNow = true,
	packageManager?: PackageManager,
): Promise<void> {
	const dependencies = Array.from(new Set(deps));
	const developmentDependencies = Array.from(new Set(devDeps));

	if (!dependencies.length && !developmentDependencies.length) {
		return;
	}

	if (!installNow) {
		await updatePackageJsonDependencies(
			dependencies,
			developmentDependencies,
			cwd,
		);
		return;
	}

	const pm = packageManager ?? inferPackageManager(cwd);
	if (dependencies.length) {
		const args =
			pm === "yarn" ? ["add", ...dependencies] : ["add", ...dependencies];
		await runCommand(pm, args, cwd);
	}

	if (developmentDependencies.length) {
		const args =
			pm === "npm"
				? ["install", "-D", ...developmentDependencies]
				: ["add", "-D", ...developmentDependencies];
		await runCommand(pm, args, cwd);
	}
}
