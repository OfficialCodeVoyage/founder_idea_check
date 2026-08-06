"use client";

import { BookOpen, Copy } from "lucide-react";
import { useState } from "react";

import { siteLinks } from "@/lib/site-config";

const command = "npx @chat-js/cli@latest create my-app";

export function GetStarted() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);

      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Ignore clipboard permission failures.
    }
  }

  return (
    <section className="relative overflow-hidden py-24 sm:py-32">
      {/* Background atmosphere */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute bottom-0 left-1/3 h-[400px] w-[500px] -translate-x-1/2 translate-y-1/4 rounded-full bg-amber-500/2 blur-[120px] dark:bg-amber-400/2.5" />
        <div className="absolute right-1/4 bottom-0 h-[350px] w-[450px] translate-y-1/3 rounded-full bg-indigo-500/1.5 blur-[100px] dark:bg-indigo-400/2" />
      </div>

      <div className="relative mx-auto max-w-3xl px-6 text-center">
        <h2 className="font-display text-3xl tracking-tight sm:text-5xl">
          Get started in under <span className="italic">five minutes</span>
        </h2>
        <p className="mt-6 text-foreground/75 text-lg">
          Scaffold a new project with a single command. Customize it, deploy it,
          ship it.
        </p>

        {/* Terminal */}
        <div className="mx-auto mt-12 max-w-lg">
          <div className="overflow-hidden rounded-xl border border-border/50 bg-card shadow-foreground/2 shadow-lg">
            <div className="flex items-center gap-2 border-border/40 border-b bg-secondary/40 px-4 py-2.5">
              <div className="flex gap-1.5">
                <div className="h-2.5 w-2.5 rounded-full bg-foreground/10" />
                <div className="h-2.5 w-2.5 rounded-full bg-foreground/10" />
                <div className="h-2.5 w-2.5 rounded-full bg-foreground/10" />
              </div>
              <span className="ml-2 text-[11px] text-foreground/65">
                Terminal
              </span>
            </div>
            <div className="flex items-center justify-between px-5 py-4">
              <code className="font-mono text-sm">
                <span className="select-none text-foreground/70">$ </span>
                <span className="text-foreground">{command}</span>
              </code>
              <button
                aria-label="Copy command"
                className="ml-3 rounded-md p-1.5 text-foreground/75 transition-colors hover:bg-secondary hover:text-foreground"
                onClick={handleCopy}
                type="button"
              >
                <span className="flex items-center gap-1.5">
                  <Copy className="h-4 w-4" />
                  <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* CTAs */}
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <a
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 font-medium text-primary-foreground text-sm shadow-lg shadow-primary/15 transition-all hover:-translate-y-0.5 hover:shadow-primary/20 hover:shadow-xl"
            href={siteLinks.docs}
          >
            <BookOpen className="h-4 w-4" />
            Read the Docs
          </a>
          <a
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card/80 px-6 py-3 font-medium text-foreground text-sm transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:bg-card"
            href={siteLinks.github}
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <title>GitHub</title>
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
