import { getProvider, type ProviderSlug } from "files-sdk/providers";

export type StorageEnvironmentVariable = {
  aliases: readonly string[];
  description: string;
  key: string;
  /**
   * Set when the platform supplies this variable instead of the env file: the
   * env var whose presence means "running there", so the variable counts as
   * present without being set.
   */
  platformFlag?: string;
  secret: boolean;
};

export type StorageEnvironmentRequirement = {
  description: string;
  options: StorageEnvironmentVariable[][];
};

const STORAGE_OPTION_HINT = /(?:or )?pass `([^`]+)`/;

// @vercel/oidc reads VERCEL_OIDC_TOKEN from the env when it is set (Vercel
// builds, `vercel env pull`); on Vercel Functions it takes the token from the
// x-vercel-oidc-token request header instead, so a deployment never has it in
// the env. Running on Vercel (`VERCEL` set) therefore counts as having it.
const PLATFORM_FLAGS: Readonly<Record<string, string>> = {
  VERCEL_OIDC_TOKEN: "VERCEL",
};

export function getStorageEnvironmentRequirements(
  provider: ProviderSlug,
  adapterOptions: Record<string, unknown> = {}
): StorageEnvironmentRequirement[] {
  const metadata = getProvider(provider);
  if (!metadata) {
    return [];
  }

  const toVariable = (variable: {
    aliases?: readonly string[];
    description: string;
    key: string;
    secret: boolean;
  }): StorageEnvironmentVariable => ({
    aliases: variable.aliases ?? [],
    description: variable.description,
    key: variable.key,
    platformFlag: PLATFORM_FLAGS[variable.key],
    secret: variable.secret,
  });
  const requirements: StorageEnvironmentRequirement[] = [];
  const required = metadata.env.required?.filter((variable) => {
    const optionName = STORAGE_OPTION_HINT.exec(variable.description)?.[1];
    return (
      variable.readBy === "files-sdk" &&
      !(
        optionName &&
        variable.secret === false &&
        adapterOptions[optionName] !== undefined
      )
    );
  });
  if (required?.length) {
    requirements.push({
      description: `${metadata.name} configuration`,
      options: [required.map(toVariable)],
    });
  }

  const credentialModes: StorageEnvironmentVariable[][] = [];
  let hasUnvalidatedCredentialMode = false;
  for (const mode of metadata.env.credentialModes ?? []) {
    // A mode that names any variable files-sdk reads itself is checked as a
    // whole, its "sdk-chain" variables included: files-sdk 3 marks Vercel
    // Blob's VERCEL_OIDC_TOKEN "sdk-chain" (@vercel/oidc reads it), and
    // dropping it would accept BLOB_STORE_ID alone, which fails at runtime off
    // Vercel. A mode made only of "sdk-chain" variables (the AWS chain, ADC)
    // can be satisfied without any env var, so it is not checked.
    if (!mode.vars.some((variable) => variable.readBy === "files-sdk")) {
      const optionName = STORAGE_OPTION_HINT.exec(mode.label)?.[1];
      hasUnvalidatedCredentialMode ||=
        optionName === undefined || adapterOptions[optionName] !== undefined;
      continue;
    }
    credentialModes.push(mode.vars.map(toVariable));
  }
  if (credentialModes.length > 0 && !hasUnvalidatedCredentialMode) {
    requirements.push({
      description: `${metadata.name} credentials`,
      options: credentialModes,
    });
  }

  return requirements;
}
