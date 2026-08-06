import { highlighter } from "./highlighter";

export const logger = {
  error(...args: unknown[]) {
    console.log(highlighter.error(String(args.join(" "))));
  },
  warn(...args: unknown[]) {
    console.log(highlighter.warn(String(args.join(" "))));
  },
  info(...args: unknown[]) {
    console.log(highlighter.info(String(args.join(" "))));
  },
  success(...args: unknown[]) {
    console.log(highlighter.success(String(args.join(" "))));
  },
  log(...args: unknown[]) {
    console.log(args.join(" "));
  },
  break() {
    console.log("");
  },
};
