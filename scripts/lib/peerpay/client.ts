/**
 * PeerPayClient lifecycle management.
 *
 * Wraps @bsv/message-box-client PeerPayClient with wallet loading
 * and anointment state tracking.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NETWORK, WALLET_DIR, OVERLAY_STATE_DIR } from '../config.js';

/** Default MessageBox host */
export const DEFAULT_MESSAGE_BOX_URL =
  process.env.MESSAGE_BOX_URL || 'https://messagebox.babbage.systems';

const ANOINT_STATE_PATH = path.join(OVERLAY_STATE_DIR, 'peerpay-anoint.json');

// Dynamic imports
let _BSVAgentWallet: any = null;
let _PeerPayClient: any = null;

async function getBSVAgentWallet(): Promise<any> {
  if (_BSVAgentWallet) return _BSVAgentWallet;
  try {
    const core = await import('@a2a-bsv/core');
    _BSVAgentWallet = core.BSVAgentWallet;
    return _BSVAgentWallet;
  } catch {
    const { fileURLToPath } = await import('node:url');
    const p = await import('node:path');
    const os = await import('node:os');
    const __dirname = p.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      p.resolve(__dirname, '..', '..', '..', 'node_modules', '@a2a-bsv', 'core', 'dist', 'index.js'),
      p.resolve(__dirname, '..', '..', '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
      p.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
    ];
    for (const c of candidates) {
      try { const core = await import(c); _BSVAgentWallet = core.BSVAgentWallet; return _BSVAgentWallet; } catch {}
    }
    throw new Error('Cannot find @a2a-bsv/core. Run setup.sh first.');
  }
}

async function getPeerPayClient(): Promise<any> {
  if (_PeerPayClient) return _PeerPayClient;
  try {
    const mod = await import('@bsv/message-box-client');
    _PeerPayClient = mod.PeerPayClient;
    return _PeerPayClient;
  } catch {
    const { fileURLToPath } = await import('node:url');
    const p = await import('node:path');
    const __dirname = p.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      p.resolve(__dirname, '..', '..', '..', 'node_modules', '@bsv', 'message-box-client', 'dist', 'esm', 'mod.js'),
    ];
    for (const c of candidates) {
      try { const mod = await import(c); _PeerPayClient = mod.PeerPayClient; return _PeerPayClient; } catch {}
    }
    throw new Error('Cannot find @bsv/message-box-client. Install it: npm i @bsv/message-box-client');
  }
}

/** Load the wallet (caller must call wallet.destroy() when done). */
export async function loadWallet(): Promise<any> {
  const BSVAgentWallet = await getBSVAgentWallet();
  return BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
}

/** Create a PeerPayClient backed by the loaded wallet. */
export async function createPeerPayClient(
  wallet: any,
  messageBoxHost?: string
): Promise<any> {
  const PeerPay = await getPeerPayClient();
  return new PeerPay({
    walletClient: wallet,
    messageBoxHost: messageBoxHost || DEFAULT_MESSAGE_BOX_URL,
    enableLogging: true,
    originator: 'overlay.openclaw.ai',
  });
}

/** Check whether the given host has been anointed. */
export function isAnointed(host: string): boolean {
  try {
    if (!fs.existsSync(ANOINT_STATE_PATH)) return false;
    const state = JSON.parse(fs.readFileSync(ANOINT_STATE_PATH, 'utf-8'));
    return !!state.hosts?.[host];
  } catch {
    return false;
  }
}

/** Record that a host has been successfully anointed. */
export function markAnointed(host: string): void {
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
  let state: any = { hosts: {} };
  try {
    if (fs.existsSync(ANOINT_STATE_PATH)) {
      state = JSON.parse(fs.readFileSync(ANOINT_STATE_PATH, 'utf-8'));
    }
  } catch {}
  state.hosts = state.hosts || {};
  state.hosts[host] = { anointedAt: new Date().toISOString() };
  fs.writeFileSync(ANOINT_STATE_PATH, JSON.stringify(state, null, 2));
}
