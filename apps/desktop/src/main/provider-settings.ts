import { safeStorage } from 'electron';
import type { Db, ProviderId } from '@command-center/core';

// Provider keys and base URLs live in the project's `settings` table. Keys are encrypted with the OS keychain
// (Electron safeStorage) when it is available (D25). They are only ever decrypted inside this process, to be put in
// a request header; the renderer is told "set / not set" and the last four characters, nothing more.

const keyName = (id: ProviderId) => `provider.${id}.key`;
const urlName = (id: ProviderId) => `provider.${id}.base_url`;

function read(db: Db, name: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(name) as
    { value: string } | undefined;
  return row?.value ?? null;
}
function write(db: Db, name: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(name);
  else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(name, value);
}

export function readProviderKey(db: Db, id: ProviderId): string | null {
  const v = read(db, keyName(id));
  if (!v) return null;
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
  } catch {
    return null; // a key encrypted on another machine/user cannot be read: treat as not set
  }
  return v.startsWith('raw:') ? v.slice(4) : null;
}

export function writeProviderKey(db: Db, id: ProviderId, key: string | null): void {
  const k = key?.trim() || null;
  write(
    db,
    keyName(id),
    k === null
      ? null
      : safeStorage.isEncryptionAvailable()
        ? `enc:${safeStorage.encryptString(k).toString('base64')}`
        : `raw:${k}`,
  );
}

export const readBaseUrl = (db: Db, id: ProviderId): string | undefined =>
  read(db, urlName(id)) ?? undefined;

export function writeBaseUrl(db: Db, id: ProviderId, url: string | null): void {
  const u = url?.trim() || null;
  if (u !== null && !/^https?:\/\/[^\s]+$/i.test(u))
    throw new Error('Use a URL that starts with http:// or https://.');
  write(db, urlName(id), u);
}
