import { FileAuthStorageBackend } from "@earendil-works/pi-coding-agent";
import { safeStorage } from "electron";
import type { CredentialStore } from "@vela/agent";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface CredentialCipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
const osCipher: CredentialCipher = {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
  encrypt: value => safeStorage.encryptString(value),
  decrypt: value => safeStorage.decryptString(value),
};

/** Main only: OS keychain-backed encryption, Pi's file locking, and atomic replacement. */
export class SecureCredentialStore implements CredentialStore {
  private readonly file: FileAuthStorageBackend;
  constructor(private readonly path: string, private readonly cipher: CredentialCipher = osCipher) { this.file = new FileAuthStorageBackend(path); }
  private read(current: string | undefined): string | undefined {
    if (!this.cipher.available()) throw new Error("Secure credential storage is unavailable");
    if (!current || current.trim() === "{}") return undefined;
    try {
      const envelope = JSON.parse(current) as { version: number; encrypted: string };
      if (envelope.version !== 1 || typeof envelope.encrypted !== "string") throw new Error();
      return this.cipher.decrypt(Buffer.from(envelope.encrypted, "base64"));
    } catch { throw new Error("Cannot unlock integration credentials"); }
  }
  private write(next: string | undefined): string | undefined {
    if (next === undefined) return undefined;
    if (!this.cipher.available()) throw new Error("Secure credential storage is unavailable");
    return JSON.stringify({ version: 1, encrypted: this.cipher.encrypt(next).toString("base64") });
  }
  private persist(next: string | undefined): void {
    const encrypted = this.write(next);
    if (encrypted === undefined) return;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, encrypted, "utf8"); fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, this.path);
    } catch { throw new Error("Cannot save integration credentials"); }
    finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    return this.file.withLock(current => {
      const outcome = fn(this.read(current));
      this.persist(outcome.next);
      return { result: outcome.result };
    });
  }
  withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
    return this.file.withLockAsync(async current => {
      const outcome = await fn(this.read(current));
      this.persist(outcome.next);
      return { result: outcome.result };
    });
  }
}
