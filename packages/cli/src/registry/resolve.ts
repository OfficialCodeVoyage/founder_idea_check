import {
  fetchRegistryItem,
  type RegistryToolItem,
  type RegistryToolItemFile,
} from "./fetch";

export type RegistryResolution = {
  items: RegistryToolItem[];
  dependencies: string[];
  devDependencies: string[];
  files: RegistryToolItemFile[];
};

export async function resolveRegistryItems(
  names: string[],
  registryUrl?: string
): Promise<RegistryResolution> {
  const seen = new Set<string>();
  const items: RegistryToolItem[] = [];

  async function visit(name: string): Promise<void> {
    if (seen.has(name)) {
      return;
    }

    seen.add(name);

    const item = await fetchRegistryItem(name, registryUrl);
    for (const dependency of item.registryDependencies ?? []) {
      await visit(dependency);
    }

    items.push(item);
  }

  for (const name of names) {
    await visit(name);
  }

  return {
    items,
    dependencies: Array.from(
      new Set(items.flatMap((item) => item.dependencies ?? []))
    ),
    devDependencies: Array.from(
      new Set(items.flatMap((item) => item.devDependencies ?? []))
    ),
    files: items.flatMap((item) => item.files),
  };
}
