/**
 * Identity resolution for PeerPay.
 *
 * Uses @bsv/sdk IdentityClient to resolve handles/names to identity keys.
 */

import { NETWORK, WALLET_DIR } from '../config.js';

// Dynamic import for @bsv/sdk
let _sdk: any = null;

async function getSdk(): Promise<any> {
  if (_sdk) return _sdk;
  try {
    _sdk = await import('@bsv/sdk');
    return _sdk;
  } catch {
    const { fileURLToPath } = await import('node:url');
    const p = await import('node:path');
    const os = await import('node:os');
    const __dirname = p.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      p.resolve(__dirname, '..', '..', '..', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
      p.resolve(__dirname, '..', '..', '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
      p.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
    ];
    for (const c of candidates) {
      try { _sdk = await import(c); return _sdk; } catch {}
    }
    throw new Error('Cannot find @bsv/sdk. Run setup.sh first.');
  }
}

export interface IdentityResult {
  identityKey: string;
  handle?: string;
  displayName?: string;
}

/**
 * Look up identities by handle or name.
 * Returns an array of matching identities.
 */
export async function lookupIdentity(
  query: string,
  wallet: any
): Promise<IdentityResult[]> {
  const sdk = await getSdk();
  const IdentityClient = sdk.IdentityClient;

  if (!IdentityClient) {
    throw new Error(
      '@bsv/sdk does not export IdentityClient. Ensure @bsv/sdk >= 2.0.1 is installed.'
    );
  }

  const client = new IdentityClient(wallet);

  // If query looks like a hex identity key (66 chars), look up directly
  if (/^[0-9a-f]{66}$/i.test(query)) {
    try {
      const result = await client.findByIdentityKey(query);
      if (result) {
        return [{
          identityKey: query,
          handle: result.handle || result.alternateName,
          displayName: result.name || result.displayName,
        }];
      }
    } catch {}
    // Even if lookup fails, the key itself is valid for payment
    return [{ identityKey: query }];
  }

  // Strip leading @ if present
  const searchTerm = query.startsWith('@') ? query.slice(1) : query;

  const results = await client.findByHandle(searchTerm);
  if (!results || (Array.isArray(results) && results.length === 0)) {
    return [];
  }

  const items = Array.isArray(results) ? results : [results];
  return items.map((r: any) => ({
    identityKey: r.identityKey,
    handle: r.handle || r.alternateName,
    displayName: r.name || r.displayName,
  }));
}
