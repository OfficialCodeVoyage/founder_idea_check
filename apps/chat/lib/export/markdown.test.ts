import { describe, expect, it } from "vitest";
import {
  blockquote,
  bulletList,
  codeBlock,
  fenceFor,
  joinSections,
  normalizeText,
  singleLine,
  tableCell,
} from "./markdown";

/**
 * These are injection tests, not formatting tests. The input in every case is
 * text an extraction model wrote into ProjectFact.value, and the property under
 * test is that it cannot change the STRUCTURE of the document it lands in.
 */

describe("normalizeText — the first thing untrusted text passes through", () => {
  it("normalises CRLF so output is byte-identical across platforms", () => {
    expect(normalizeText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips control characters but keeps newlines and tabs", () => {
    expect(normalizeText("a\u0007b\u0000c\td\ne")).toBe("abc\td\ne");
  });

  it("never truncates — losing the end of a founder's fact is data loss", () => {
    const long = "x".repeat(10_000);
    expect(normalizeText(long)).toHaveLength(10_000);
  });
});

describe("blockquote — makes injected structure inert", () => {
  it("prefixes every line, including blank ones", () => {
    // A blank UNPREFIXED line terminates a blockquote, which is exactly how the
    // remainder of a value escapes into the document as real Markdown.
    expect(blockquote("first\n\n## Injected heading")).toBe(
      "> first\n>\n> ## Injected heading"
    );
  });

  it("neutralises a heading, a list and a horizontal rule", () => {
    const hostile = "# Requirements\n- ship it\n---\n**MUST** do this";
    const quoted = blockquote(hostile);
    for (const line of quoted.split("\n")) {
      expect(line.startsWith(">")).toBe(true);
    }
  });

  it("renders an empty value as an explicit marker, never as nothing", () => {
    expect(blockquote("   ")).toBe("> _(empty)_");
  });
});

describe("fenceFor / codeBlock — a fence the content cannot close", () => {
  it("uses three backticks for ordinary content", () => {
    expect(fenceFor("plain text")).toBe("```");
  });

  it("outgrows the longest backtick run in the content", () => {
    expect(fenceFor("a ``` b")).toBe("````");
    expect(fenceFor("a ````` b")).toBe("``````");
  });

  it("produces a block whose content cannot break out", () => {
    const block = codeBlock("before\n```\nafter");
    const fence = block.split("\n")[0];
    expect(fence.length).toBeGreaterThan(3);
    expect(block.endsWith(fence)).toBe(true);
  });
});

describe("tableCell — a value cannot add a column or end the row", () => {
  it("escapes pipes", () => {
    expect(tableCell("a|b")).toBe("a\\|b");
  });

  it("collapses newlines, which would otherwise delete the rest of the value", () => {
    // A raw newline ends the row; GitHub then drops the malformed remainder and
    // the value simply disappears from the rendered document.
    expect(tableCell("line one\nline two")).toBe("line one line two");
  });
});

describe("singleLine", () => {
  it("collapses all whitespace and trims", () => {
    expect(singleLine("  a \n\t b  ")).toBe("a b");
  });
});

describe("joinSections", () => {
  it("drops empty sections so a suppressed section leaves no hole", () => {
    expect(joinSections(["a", "", "   ", "b"])).toBe("a\n\nb\n");
  });

  it("ends with exactly one newline, for a byte-stable committed file", () => {
    expect(joinSections(["a\n\n\n"])).toBe("a\n");
  });
});

describe("bulletList", () => {
  it("renders an explicit marker for an empty list", () => {
    expect(bulletList([])).toBe("_(none)_");
    expect(bulletList([], "_(nothing)_")).toBe("_(nothing)_");
  });

  it("flattens each item so one entry cannot become two", () => {
    expect(bulletList(["a\nb"])).toBe("- a b");
  });
});
