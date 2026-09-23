import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialVault } from '@jupiter/ai-runtime';
import { safeStorage } from 'electron';

export class DpapiCredentialVault implements CredentialVault {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  get(providerId: string): Promise<string | undefined> {
    const filePath = this.#path(providerId);
    if (!existsSync(filePath)) return Promise.resolve(undefined);
    if (!safeStorage.isEncryptionAvailable()) throw unavailableError();
    return Promise.resolve(safeStorage.decryptString(readFileSync(filePath)));
  }

  set(providerId: string, credential: string): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) throw unavailableError();
    const encrypted = safeStorage.encryptString(credential);
    writeFileSync(this.#path(providerId), encrypted, { mode: 0o600 });
    return Promise.resolve(
      `sha256:${createHash('sha256').update(credential).digest('hex').slice(0, 8)}`,
    );
  }

  delete(providerId: string): Promise<void> {
    const filePath = this.#path(providerId);
    if (existsSync(filePath)) unlinkSync(filePath);
    return Promise.resolve();
  }

  #path(providerId: string): string {
    const digest = createHash('sha256').update(providerId).digest('hex');
    return join(this.#directory, `${digest}.credential`);
  }
}

function unavailableError(): Error {
  return new Error('Windows secure credential encryption is unavailable.');
}
