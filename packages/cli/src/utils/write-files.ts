import fs from "node:fs/promises";
import path from "node:path";
import type { RegistryToolItemFile } from "../registry/schema";
import { isSafeTarget } from "./is-safe-target";

function rewriteToolkitImports(content: string, toolsAlias: string): string {
  return content.replace(
    /(["'])@toolkit\/(lib|components|hooks)\/([^"'`]+)\1/g,
    (_match, quote: string, kind: string, rest: string) =>
      `${quote}${toolsAlias}/_shared/${kind}/${rest}${quote}`
  );
}

async function assertNoSymlinkTraversal(
  dest: string,
  toolsDir: string
): Promise<void> {
  const relativeParent = path.relative(toolsDir, path.dirname(dest));
  const segments = relativeParent
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  let currentPath = toolsDir;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stat = await fs.lstat(currentPath).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new Error(
        `Refusing to write through symlinked path "${path.relative(toolsDir, currentPath)}"`
      );
    }
  }
}

/**
 * Write tool files to disk.
 * Each file's `target` is resolved relative to `toolsDir`.
 * Returns the list of absolute paths that were written.
 */
export async function writeToolFiles(
  files: RegistryToolItemFile[],
  {
    overwrite = false,
    toolsDir,
    toolsAlias,
  }: {
    overwrite?: boolean;
    toolsDir: string;
    toolsAlias: string;
  }
): Promise<{ written: string[]; existing: string[] }> {
  const written: string[] = [];
  const existing: string[] = [];

  for (const file of files) {
    if (!isSafeTarget(file.target, toolsDir)) {
      throw new Error(
        `Refusing to write "${file.target}" outside the tools directory`
      );
    }

    const dest = path.resolve(toolsDir, file.target);
    await assertNoSymlinkTraversal(dest, toolsDir);

    const exists = await fs
      .access(dest)
      .then(() => true)
      .catch(() => false);

    if (exists && !overwrite) {
      existing.push(dest);
      continue;
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    const realToolsDir = await fs
      .realpath(toolsDir)
      .catch(() => path.resolve(toolsDir));
    const realParentDir = await fs.realpath(path.dirname(dest));
    if (
      realParentDir !== realToolsDir &&
      !realParentDir.startsWith(`${realToolsDir}${path.sep}`)
    ) {
      throw new Error(
        `Refusing to write "${file.target}" outside the tools directory`
      );
    }
    if (exists) {
      const stat = await fs.lstat(dest);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlinked file "${file.target}"`);
      }
    }
    const content =
      dest.endsWith(".ts") || dest.endsWith(".tsx") || dest.endsWith(".js")
        ? rewriteToolkitImports(file.content, toolsAlias)
        : file.content;
    await fs.writeFile(dest, content, "utf8");
    written.push(dest);
  }

  return { written, existing };
}
