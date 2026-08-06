import type { Tool, UIToolInvocation } from "ai";

export type ToolPartFromTool<T extends Tool> = UIToolInvocation<T>;

export type TypelessToolPartFromTool<T extends Tool> = ToolPartFromTool<T>;
