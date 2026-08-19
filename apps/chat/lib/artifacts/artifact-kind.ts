export const artifactKinds = ["text", "code", "sheet", "persona"] as const;
export type ArtifactKind = (typeof artifactKinds)[number];
