import { afterEach, describe, expect, it, vi } from "vitest";
import { copyArtifactToClipboard } from "./copy-to-clipboard";

const NO_TEXT = /no text to copy/i;
const NO_CODE = /no code to copy/i;
const CLIPBOARD = /clipboard/i;

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyArtifactToClipboard", () => {
  it("copies real content and reports how much", async () => {
    const written: string[] = [];
    stubClipboard((text) => {
      written.push(text);
      return Promise.resolve();
    });

    const outcome = await copyArtifactToClipboard({
      content: "# Protocol\n\nbody",
      what: "text",
    });

    expect(written).toEqual(["# Protocol\n\nbody"]);
    expect(outcome.copied).toBe(true);
    if (!outcome.copied) {
      return;
    }
    expect(outcome.chars).toBe("# Protocol\n\nbody".length);
  });

  it("refuses an empty document instead of reporting success", async () => {
    let called = false;
    stubClipboard(() => {
      called = true;
      return Promise.resolve();
    });

    const outcome = await copyArtifactToClipboard({
      content: "",
      what: "text",
    });

    expect(called).toBe(false);
    expect(outcome.copied).toBe(false);
    if (outcome.copied) {
      return;
    }
    expect(outcome.why).toMatch(NO_TEXT);
  });

  it("refuses whitespace-only content", async () => {
    stubClipboard(() => Promise.resolve());
    const outcome = await copyArtifactToClipboard({
      content: "   \n\t\n ",
      what: "code",
    });
    expect(outcome.copied).toBe(false);
    if (!outcome.copied) {
      expect(outcome.why).toMatch(NO_CODE);
    }
  });

  it("awaits the write and reports a rejection rather than swallowing it", async () => {
    stubClipboard(() => Promise.reject(new Error("Document is not focused")));

    const outcome = await copyArtifactToClipboard({
      content: "something",
      what: "text",
    });

    expect(outcome.copied).toBe(false);
    if (outcome.copied) {
      return;
    }
    expect(outcome.why).toContain("Document is not focused");
  });

  it("names the missing clipboard API rather than throwing", async () => {
    vi.stubGlobal("navigator", {});

    const outcome = await copyArtifactToClipboard({
      content: "something",
      what: "text",
    });

    expect(outcome.copied).toBe(false);
    if (!outcome.copied) {
      expect(outcome.why).toMatch(CLIPBOARD);
    }
  });

  it("the failed arm carries no character count to misread as a success", async () => {
    stubClipboard(() => Promise.reject(new Error("nope")));
    const outcome = await copyArtifactToClipboard({
      content: "x",
      what: "text",
    });
    expect(outcome).not.toHaveProperty("chars");
  });
});
