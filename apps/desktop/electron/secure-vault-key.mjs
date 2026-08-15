import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const KEY_BYTES = 32;

/**
 * @param {string} filePath
 * @param {Buffer} encrypted
 */
async function replaceProtectedKey(filePath, encrypted) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * @param {string} encoded
 */
function decodeKey(encoded) {
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("The protected OpenWork credential key is invalid.");
  }
  return key;
}

/**
 * Creates a lazy key provider so Electron does not initialize secure storage
 * until a user opts into OpenWork-managed OAuth.
 *
 * @param {{
 *   filePath: string;
 *   loadSafeStorage: () => import("electron").SafeStorage;
 *   platform?: NodeJS.Platform;
 * }} options
 */
export function createDesktopVaultKeyProvider({
  filePath,
  loadSafeStorage,
  platform = process.platform,
}) {
  /** @type {Promise<Buffer> | null} */
  let pending = null;

  async function loadKey() {
    const safeStorage = loadSafeStorage();
    if (!safeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("Operating-system secure storage is unavailable for OpenWork-managed OAuth.");
    }
    if (platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      throw new Error("A secure Linux password store is required for OpenWork-managed OAuth.");
    }

    try {
      const encrypted = await readFile(filePath);
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      const key = decodeKey(decrypted.result);
      if (decrypted.shouldReEncrypt) {
        await replaceProtectedKey(filePath, await safeStorage.encryptStringAsync(decrypted.result));
      }
      return key;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const key = randomBytes(KEY_BYTES);
    await replaceProtectedKey(filePath, await safeStorage.encryptStringAsync(key.toString("base64")));
    return key;
  }

  return async () => {
    pending ??= loadKey();
    try {
      return Buffer.from(await pending);
    } catch (error) {
      pending = null;
      throw error;
    }
  };
}
