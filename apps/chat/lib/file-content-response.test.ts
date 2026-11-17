import assert from "node:assert/strict";
import { type Adapter, Files } from "files-sdk";
import { memory } from "files-sdk/memory";
import { beforeEach, describe, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  config: { appPrefix: "file-response-test" },
}));

vi.mock("./storage-provider", async () => {
  const { memory } = await import("files-sdk/memory");
  return {
    storageProvider: {
      createAdapter: () => memory(),
      options: {},
      slug: "memory",
    },
  };
});

vi.mock("server-only", () => ({}));

const queries = vi.hoisted(() => ({
  getChatById: vi.fn(),
  getFileReferencesByChatId: vi.fn(),
}));
vi.mock("@/lib/db/queries", () => queries);

import { createFileContentResponse } from "./file-content-response";
import { uploadFile } from "./file-storage";
import { fileUrlInChat } from "./file-url";

const OWNER = "user-1";
const VIEWER = "user-2";
const CHAT_ID = "00000000-0000-4000-8000-000000000001";

function get(url: string) {
  return new Request(new URL(url, "https://chat.example"));
}

/** A stored reference, written by the database at `createdAt`. */
function ref(url: string, createdAt = new Date()) {
  return { url, createdAt };
}

describe("file access through a chat", () => {
  beforeEach(() => {
    queries.getChatById.mockReset();
    queries.getFileReferencesByChatId.mockReset();
  });

  async function ownersFileInChat(visibility: "public" | "private") {
    const uploaded = await uploadFile("a.txt", "secret", "text/plain", OWNER);
    queries.getChatById.mockResolvedValue({
      id: CHAT_ID,
      userId: OWNER,
      visibility,
    });
    queries.getFileReferencesByChatId.mockResolvedValue([ref(uploaded.url)]);
    return uploaded.url;
  }

  it("serves the owner without a chat lookup", async () => {
    const url = await ownersFileInChat("private");
    const response = await createFileContentResponse(get(url), OWNER);
    assert.equal(response.status, 200);
    assert.equal(queries.getChatById.mock.calls.length, 0);
  });

  it("serves a shared chat's file to a signed-out or other viewer", async () => {
    const url = fileUrlInChat(await ownersFileInChat("public"), CHAT_ID);
    assert.equal((await createFileContentResponse(get(url), null)).status, 200);
    assert.equal(
      (await createFileContentResponse(get(url), VIEWER)).status,
      200
    );
  });

  it("refuses a private chat's file to anyone but its owner", async () => {
    const url = fileUrlInChat(await ownersFileInChat("private"), CHAT_ID);
    assert.equal((await createFileContentResponse(get(url), null)).status, 404);
    assert.equal(
      (await createFileContentResponse(get(url), VIEWER)).status,
      404
    );
  });

  it("refuses a file the chat's owner did not store, even if the chat references it", async () => {
    const victims = await uploadFile("v.txt", "secret", "text/plain", "victim");
    // The attacker's own public chat references the victim's key.
    queries.getChatById.mockResolvedValue({
      id: CHAT_ID,
      userId: VIEWER,
      visibility: "public",
    });
    queries.getFileReferencesByChatId.mockResolvedValue([ref(victims.url)]);

    const url = fileUrlInChat(victims.url, CHAT_ID);
    assert.equal(
      (await createFileContentResponse(get(url), VIEWER)).status,
      404
    );
    assert.equal((await createFileContentResponse(get(url), null)).status, 404);
  });

  it("refuses an owner's file that the named public chat does not reference", async () => {
    const other = await uploadFile("b.txt", "private", "text/plain", OWNER);
    await ownersFileInChat("public");
    const url = fileUrlInChat(other.url, CHAT_ID);
    assert.equal((await createFileContentResponse(get(url), null)).status, 404);
  });

  it("serves a pre-tag file only through a reference written before the owner tag existed", async () => {
    const legacyUrl = "/api/files/content?key=l_u0a2bkphKLFKsBI4q5Tue9.txt";
    const viaChat = get(fileUrlInChat(legacyUrl, CHAT_ID));
    queries.getChatById.mockResolvedValue({
      id: CHAT_ID,
      userId: OWNER,
      visibility: "public",
    });

    // Without a chat, a pre-tag key proves no owner.
    const noChat = await createFileContentResponse(get(legacyUrl), OWNER);
    assert.equal(await noChat.text(), "Not found");

    // A reference written after the rollout (a pasted pre-tag link) is refused.
    queries.getFileReferencesByChatId.mockResolvedValue([ref(legacyUrl)]);
    const pasted = await createFileContentResponse(viaChat.clone(), VIEWER);
    assert.equal(await pasted.text(), "Not found");

    // A reference written before it passes the access check; the memory
    // store does not hold the file, so storage then answers "File not found".
    queries.getFileReferencesByChatId.mockResolvedValue([
      ref(legacyUrl, new Date("2026-01-01T00:00:00Z")),
    ]);
    const original = await createFileContentResponse(viaChat, VIEWER);
    assert.equal(original.status, 404);
    assert.equal(await original.text(), "File not found");
  });

  it("answers 401 to a signed-out request with no chat, and denies on lookup errors", async () => {
    const url = await ownersFileInChat("public");
    assert.equal((await createFileContentResponse(get(url), null)).status, 401);

    queries.getChatById.mockRejectedValue(new Error("db down"));
    const response = await createFileContentResponse(
      get(fileUrlInChat(url, CHAT_ID)),
      null
    );
    assert.equal(response.status, 404);
  });
});

describe("file content response", () => {
  it("serves byte ranges", async () => {
    const uploaded = await uploadFile(
      "hello.txt",
      "hello",
      "text/plain",
      OWNER
    );

    const response = await createFileContentResponse(
      new Request(new URL(uploaded.url, "https://chat.example"), {
        headers: { Range: "bytes=1-3" },
      }),
      OWNER
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 1-3/5");
    assert.equal(await response.text(), "ell");

    const suffixResponse = await createFileContentResponse(
      new Request(new URL(uploaded.url, "https://chat.example"), {
        headers: { Range: "bytes=-2" },
      }),
      OWNER
    );
    assert.equal(suffixResponse.status, 206);
    assert.equal(await suffixResponse.text(), "lo");
  });

  it("rejects unsatisfiable ranges", async () => {
    const uploaded = await uploadFile("short.txt", "hi", "text/plain", OWNER);

    const response = await createFileContentResponse(
      new Request(new URL(uploaded.url, "https://chat.example"), {
        headers: { Range: "bytes=5-8" },
      }),
      OWNER
    );

    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */2");
  });
});

describe("file content response on a store that can sign", () => {
  it("streams an allowed file and never answers with a provider link", async () => {
    // The memory store above cannot sign, so a redirect re-added to
    // createFileContentResponse would pass every test in this file. files-sdk
    // signs presigned GET links for a private Vercel Blob, S3, GCS, Azure, R2
    // and more, and such a link works for whoever holds it until it expires,
    // without the access check. This store declares signing and hands out such
    // a link, so a redirect shows up as a 3xx with a Location header.
    const memoryStore = memory();
    const signedUrl = vi.fn(
      async (key: string) => `https://provider.example/${key}?X-Signature=abc`
    );
    const adapter = {
      ...memoryStore,
      capabilities: {
        ...memoryStore.capabilities,
        signedUrl: { supported: true, expiry: "exact", disposition: true },
      },
      url: signedUrl,
    } satisfies Adapter;
    assert.equal(new Files({ adapter }).capabilities.signedUrl.supported, true);

    // file-storage keeps the adapter in a module-level singleton, so a fresh
    // module graph is what makes it pick up this store.
    vi.resetModules();
    vi.doMock("./storage-provider", () => ({
      storageProvider: {
        createAdapter: () => adapter,
        options: {},
        slug: "signing-stub",
      },
    }));
    try {
      const { createFileContentResponse: serve } = await import(
        "./file-content-response"
      );
      const { uploadFile: upload } = await import("./file-storage");
      const bytes = new TextEncoder().encode("stored bytes");
      const uploaded = await upload("a.txt", bytes, "text/plain", OWNER);

      const response = await serve(get(uploaded.url), OWNER);

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("location"), null);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      assert.equal(signedUrl.mock.calls.length, 0);
    } finally {
      vi.doUnmock("./storage-provider");
      vi.resetModules();
    }
  });
});
