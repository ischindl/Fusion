import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveGlobalDir } from "./global-settings.js";

export const MASTER_KEY_KEYCHAIN_SERVICE = "fusion";
export const MASTER_KEY_KEYCHAIN_ACCOUNT = "master-key";
export const MASTER_KEY_FILENAME = "master.key";

export type KeytarLike = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

export class MasterKeyPermissionError extends Error {
  constructor(message = "master key file permissions must be 0600") {
    super(message);
    this.name = "MasterKeyPermissionError";
  }
}

export class MasterKeyCorruptError extends Error {
  constructor(public readonly backend: "keychain" | "file", message: string) {
    super(message);
    this.name = "MasterKeyCorruptError";
  }
}

export class MasterKeyManager {
  private readonly globalDir: string;
  private readonly filePath: string;
  private readonly injectedKeytar?: KeytarLike;

  constructor(options?: { globalDir?: string; keytarModule?: KeytarLike }) {
    this.globalDir = resolveGlobalDir(options?.globalDir);
    this.filePath = join(this.globalDir, MASTER_KEY_FILENAME);
    this.injectedKeytar = options?.keytarModule;
  }

  async getOrCreateKey(): Promise<Buffer> {
    const keychainKey = await this.readKeychainKey();
    if (keychainKey) {
      return keychainKey;
    }

    const fileKey = await this.readFileKey();
    if (fileKey) {
      return fileKey;
    }

    const generated = randomBytes(32);
    const persisted = await this.persistNewKeyWithRaceHandling(generated);
    console.info(`master key created (${await this.getBackend()})`);
    return persisted;
  }

  async rotateKey(): Promise<Buffer> {
    const next = randomBytes(32);
    const backend = await this.getBackend();

    if (backend === "file") {
      await this.writeFileKey(next, { overwrite: true });
      console.info("master key rotated (file)");
      return next;
    }

    const wroteKeychain = await this.writeKeychainKey(next);
    if (wroteKeychain) {
      console.info("master key rotated (keychain)");
      return next;
    }

    await this.writeFileKey(next, { overwrite: true });
    console.info("master key rotated (file)");
    return next;
  }

  async getBackend(): Promise<"keychain" | "file" | "missing"> {
    const keychainKey = await this.readKeychainKey();
    if (keychainKey) {
      return "keychain";
    }

    const fileKey = await this.readFileKey();
    if (fileKey) {
      return "file";
    }

    return "missing";
  }

  private async persistNewKeyWithRaceHandling(generated: Buffer): Promise<Buffer> {
    const keytar = await this.loadKeytar();
    if (keytar) {
      const raced = await this.readKeychainKey();
      if (raced) {
        return raced;
      }
      try {
        await keytar.setPassword(
          MASTER_KEY_KEYCHAIN_SERVICE,
          MASTER_KEY_KEYCHAIN_ACCOUNT,
          generated.toString("base64"),
        );
        return generated;
      } catch {
        const afterRace = await this.readKeychainKey();
        if (afterRace) {
          return afterRace;
        }
        console.warn("master key keychain unavailable; using file backend");
      }
    }

    const racedFile = await this.readFileKey();
    if (racedFile) {
      return racedFile;
    }

    try {
      await this.writeFileKey(generated, { overwrite: false });
      return generated;
    } catch {
      const afterRace = await this.readFileKey();
      if (afterRace) {
        return afterRace;
      }
      throw new Error("failed to persist master key");
    }
  }

  private async readKeychainKey(): Promise<Buffer | null> {
    const keytar = await this.loadKeytar();
    if (!keytar) {
      return null;
    }

    try {
      const value = await keytar.getPassword(
        MASTER_KEY_KEYCHAIN_SERVICE,
        MASTER_KEY_KEYCHAIN_ACCOUNT,
      );
      if (!value) {
        return null;
      }
      const decoded = Buffer.from(value, "base64");
      if (decoded.length !== 32 || decoded.toString("base64") !== value) {
        throw new MasterKeyCorruptError("keychain", "keychain master key is corrupt");
      }
      return decoded;
    } catch (error) {
      if (error instanceof MasterKeyCorruptError) {
        throw error;
      }
      console.warn("master key keychain unavailable; using file backend");
      return null;
    }
  }

  private async readFileKey(): Promise<Buffer | null> {
    try {
      const value = await readFile(this.filePath);
      if (value.length !== 32) {
        throw new MasterKeyCorruptError("file", "file master key is corrupt");
      }
      return value;
    } catch (error) {
      if (error instanceof MasterKeyCorruptError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeFileKey(value: Buffer, options: { overwrite: boolean }): Promise<void> {
    await mkdir(this.globalDir, { recursive: true });
    const handle = await open(this.filePath, options.overwrite ? "w" : "wx");
    try {
      await handle.writeFile(value);
    } finally {
      await handle.close();
    }
    await chmod(this.filePath, 0o600);
    const fileStat = await stat(this.filePath);
    if ((fileStat.mode & 0o777) !== 0o600) {
      throw new MasterKeyPermissionError();
    }
  }

  private async writeKeychainKey(value: Buffer): Promise<boolean> {
    const keytar = await this.loadKeytar();
    if (!keytar) {
      return false;
    }

    try {
      await keytar.setPassword(
        MASTER_KEY_KEYCHAIN_SERVICE,
        MASTER_KEY_KEYCHAIN_ACCOUNT,
        value.toString("base64"),
      );
      return true;
    } catch {
      console.warn("master key keychain unavailable; using file backend");
      return false;
    }
  }

  private async loadKeytar(): Promise<KeytarLike | null> {
    if (this.injectedKeytar) {
      return this.injectedKeytar;
    }

    try {
      const module = await import("keytar");
      return module.default as KeytarLike;
    } catch {
      return null;
    }
  }
}
