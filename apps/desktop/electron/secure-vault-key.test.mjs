import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDesktopVaultKeyProvider } from "./secure-vault-key.mjs";

/**
 * @param {Partial<import("electron").SafeStorage>} overrides
 * @returns {import("electron").SafeStorage}
 */
function fakeSafeStorage(overrides = {}) {
  return /** @type {import("electron").SafeStorage} */ ({
    decryptString: () => { throw new Error("sync safe storage is not used"); },
    encryptString: () => { throw new Error("sync safe storage is not used"); },
    isAsyncEncryptionAvailable: async () => true,
    isEncryptionAvailable: () => true,
    setUsePlainTextEncryption: () => {},
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async (plaintext) => Buffer.from(`sealed:${Buffer.from(plaintext).toString("hex")}`),
    decryptStringAsync: async (encrypted) => ({
      result: Buffer.from(encrypted.toString().slice("sealed:".length), "hex").toString(),
      shouldReEncrypt: false,
    }),
    ...overrides,
  });
}

describe("desktop managed MCP vault key", () => {
  it("persists only an OS-protected blob and restores the same key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwork-vault-key-"));
    const filePath = path.join(root, "vault-key.bin");
    try {
      const safeStorage = fakeSafeStorage();
      const firstProvider = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => safeStorage });
      const first = await firstProvider();
      assert.equal(first.byteLength, 32);
      assert.deepEqual(await firstProvider(), first);

      const protectedBlob = await readFile(filePath);
      assert.equal(protectedBlob.includes(first.toString("base64")), false);
      if (process.platform !== "win32") {
        assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      }

      const restartedProvider = createDesktopVaultKeyProvider({ filePath, loadSafeStorage: () => safeStorage });
      assert.deepEqual(await restartedProvider(), first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects Electron's insecure Linux basic-text backend", async () => {
    const provider = createDesktopVaultKeyProvider({
      filePath: path.join(os.tmpdir(), "unused-openwork-vault-key.bin"),
      loadSafeStorage: () => fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }),
      platform: "linux",
    });
    await assert.rejects(provider(), /secure Linux password store/);
  });

  it("fails closed when OS secure storage is unavailable", async () => {
    const provider = createDesktopVaultKeyProvider({
      filePath: path.join(os.tmpdir(), "unused-openwork-vault-key.bin"),
      loadSafeStorage: () => fakeSafeStorage({ isAsyncEncryptionAvailable: async () => false }),
    });
    await assert.rejects(provider(), /secure storage is unavailable/);
  });
});
