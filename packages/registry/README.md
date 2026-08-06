# @chat-js/registry

Published ChatJS registry artifacts and authoring types.

The package is distributed through npm. The CLI consumes the published
`items/*.json` manifests from the package contents via the default npm-backed
registry URL, so there is no separate registry deploy step.

This package contains:

- `index.json` with the registry index
- `items/*.json` with generated registry tool manifests
- `ToolEnvVars` for typing static `toolEnvVars` exports in `tool.ts`
