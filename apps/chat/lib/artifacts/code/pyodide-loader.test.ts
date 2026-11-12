import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The loader's job is to fetch the runtime script on first use, once, and to
 * fail with words instead of hanging. A stub `document` stands in for the
 * browser: it records each injected `<script>` so a test can finish its load
 * or its failure by hand.
 */
type FakeScript = {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  remove: () => void;
};

const COULD_NOT_DOWNLOAD = /could not be downloaded/;
const DID_NOT_FINISH = /did not finish/;

let injected: FakeScript[];

function installFakeBrowser() {
  injected = [];
  vi.stubGlobal("document", {
    createElement: (): FakeScript => ({
      src: "",
      async: false,
      onload: null,
      onerror: null,
      remove: vi.fn(),
    }),
    head: { appendChild: (script: FakeScript) => injected.push(script) },
  });
}

async function freshLoader() {
  vi.resetModules();
  return await import("./pyodide-loader");
}

describe("loadPyodideRuntime", () => {
  beforeEach(() => {
    installFakeBrowser();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("injects nothing until a run asks for the runtime", async () => {
    await freshLoader();
    expect(injected).toHaveLength(0);
  });

  it("shares one script between concurrent runs and passes the pinned index URL", async () => {
    const { loadPyodideRuntime } = await freshLoader();
    const instance = { runPythonAsync: vi.fn() };
    const factory = vi.fn().mockResolvedValue(instance);

    const first = loadPyodideRuntime();
    const second = loadPyodideRuntime();
    expect(injected).toHaveLength(1);
    expect(injected[0].src).toBe(
      "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js"
    );

    vi.stubGlobal("loadPyodide", factory);
    injected[0].onload?.();

    expect(await first).toBe(instance);
    expect(await second).toBe(instance);
    expect(factory).toHaveBeenCalledWith({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/",
    });
  });

  it("does not inject a second script once the runtime is already on the page", async () => {
    const { loadPyodideRuntime } = await freshLoader();
    const instance = {};
    vi.stubGlobal("loadPyodide", vi.fn().mockResolvedValue(instance));

    expect(await loadPyodideRuntime()).toBe(instance);
    expect(injected).toHaveLength(0);
  });

  it("rejects with a readable message when the download fails, then lets a later run retry", async () => {
    const { loadPyodideRuntime } = await freshLoader();

    const failed = loadPyodideRuntime();
    injected[0].onerror?.();
    await expect(failed).rejects.toThrow(COULD_NOT_DOWNLOAD);
    expect(injected[0].remove).toHaveBeenCalled();

    const instance = {};
    const retry = loadPyodideRuntime();
    expect(injected).toHaveLength(2);
    vi.stubGlobal("loadPyodide", vi.fn().mockResolvedValue(instance));
    injected[1].onload?.();
    expect(await retry).toBe(instance);
  });

  it("gives up with a readable message when the script never loads or fails", async () => {
    vi.useFakeTimers();
    const { loadPyodideRuntime } = await freshLoader();

    const stalled = loadPyodideRuntime();
    const assertion = expect(stalled).rejects.toThrow(DID_NOT_FINISH);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
