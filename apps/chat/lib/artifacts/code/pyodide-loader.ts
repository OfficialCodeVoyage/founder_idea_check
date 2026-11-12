/**
 * LOADS THE PYTHON RUNTIME ONLY WHEN A PYTHON ARTIFACT IS RUN.
 *
 * `pyodide.js` used to be a `<Script strategy="afterInteractive">` in the root
 * layout, so EVERY page view asked a third-party CDN for it and downloaded a
 * Python runtime most visits never use. It is now injected on first use, by the
 * Run action in `client.tsx`, and nowhere else.
 *
 * Same CDN, same version: the script and the `indexURL` the runtime fetches its
 * packages from must name the same release, so both come from one constant.
 * Self-hosting is a separate decision.
 */

const PYODIDE_BASE_URL = "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/";
const PYODIDE_SCRIPT_URL = `${PYODIDE_BASE_URL}pyodide.js`;

/**
 * How long to wait for the script before giving up. A blocked or stalled CDN
 * fires neither `load` nor `error`, and a Run button that spins for ever is the
 * failure this bound exists to prevent.
 */
const SCRIPT_TIMEOUT_MS = 30_000;

const LOAD_FAILED =
  "The Python runtime could not be downloaded from cdn.jsdelivr.net, so this code was not run. Check your connection (or any content blocker) and press Run again.";
const LOAD_TIMED_OUT =
  "The Python runtime did not finish downloading from cdn.jsdelivr.net, so this code was not run. Check your connection and press Run again.";

/** The part of a Pyodide instance the Run action uses. */
export interface PyodideRuntime {
  loadPackagesFromImports(
    code: string,
    options?: { messageCallback?: (message: string) => void }
  ): Promise<void>;
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { batched: (output: string) => void }): void;
}

type PyodideFactory = (options: {
  indexURL: string;
}) => Promise<PyodideRuntime>;

function installedFactory(): PyodideFactory | undefined {
  const candidate = (globalThis as { loadPyodide?: unknown }).loadPyodide;
  return typeof candidate === "function"
    ? (candidate as PyodideFactory)
    : undefined;
}

/**
 * One in-flight (or finished) script load, so concurrent runs share a single
 * `<script>`. Cleared on failure: a transient network error must not poison
 * every later Run until the page is reloaded.
 */
let scriptLoad: Promise<PyodideFactory> | undefined;

function injectScript(): Promise<PyodideFactory> {
  return new Promise<PyodideFactory>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("The Python runtime can only be loaded in a browser."));
      return;
    }

    const script = document.createElement("script");
    const fail = (message: string) => {
      clearTimeout(timer);
      script.remove();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail(LOAD_TIMED_OUT), SCRIPT_TIMEOUT_MS);

    script.src = PYODIDE_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      const factory = installedFactory();
      if (factory) {
        resolve(factory);
        return;
      }
      fail(LOAD_FAILED);
    };
    script.onerror = () => fail(LOAD_FAILED);
    document.head.appendChild(script);
  });
}

function loadScript(): Promise<PyodideFactory> {
  const already = installedFactory();
  if (already) {
    return Promise.resolve(already);
  }
  if (!scriptLoad) {
    scriptLoad = injectScript().catch((error: unknown) => {
      scriptLoad = undefined;
      throw error;
    });
  }
  return scriptLoad;
}

/**
 * A fresh Pyodide instance, downloading the runtime script first if this page
 * has not needed it yet. Rejects with a sentence a founder can act on when the
 * script cannot be fetched; the Run action shows that sentence as the run's
 * output.
 */
export async function loadPyodideRuntime(): Promise<PyodideRuntime> {
  const loadPyodide = await loadScript();
  return loadPyodide({ indexURL: PYODIDE_BASE_URL });
}
