#!/usr/bin/env node
/**
 * overlay-cli.mjs — Unified CLI for the Clawdbot BSV Overlay skill.
 *
 * Combines BSV wallet management, overlay registration/discovery, service
 * advertisement, and micropayments into a single self-contained CLI.
 *
 * All output is JSON with a { success, data/error } wrapper for agent parsing.
 *
 * Environment variables:
 *   BSV_WALLET_DIR  — wallet storage directory (default: ~/.clawdbot/bsv-wallet)
 *   BSV_NETWORK     — 'mainnet' or 'testnet' (default: mainnet)
 *   OVERLAY_URL     — overlay server URL (default: http://162.243.168.235:8080)
 *   AGENT_NAME      — agent display name for registration
 *
 * Commands:
 *   setup                                              — Create wallet, show identity
 *   identity                                           — Show identity public key
 *   address                                            — Show P2PKH receive address
 *   balance                                            — Show balance in satoshis
 *   import <txid> [vout]                               — Import external UTXO with merkle proof
 *   refund <address>                                   — Sweep wallet to address
 *   register                                           — Register identity + joke service on overlay
 *   unregister                                         — (future) Remove from overlay
 *   services                                           — List my advertised services
 *   advertise <serviceId> <name> <desc> <priceSats>    — Add a service to overlay
 *   remove <serviceId>                                 — Remove a service (future)
 *   discover [--service <type>] [--agent <name>]       — Find agents/services on overlay
 *   pay <identityKey> <sats> [description]             — Pay another agent
 *   verify <beef_base64>                               — Verify incoming payment
 *   accept <beef> <prefix> <suffix> <senderKey> [desc] — Accept payment
 *
 * Messaging:
 *   send <identityKey> <type> <json_payload>           — Send a message via relay
 *   inbox [--since <ms>]                               — Check inbox for pending messages
 *   ack <messageId> [messageId2 ...]                   — Mark messages as read
 *   poll                                               — Process inbox (auto-handle known types)
 *   connect                                            — WebSocket real-time message processing
 *   request-service <identityKey> <serviceId> [sats]   — Pay + request a service
 */

// Suppress dotenv noise
const _origLog = console.log;
console.log = () => {};

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Resolve the @a2a-bsv/core library
// ---------------------------------------------------------------------------
let core;
try {
  core = await import('@a2a-bsv/core');
} catch {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Try several possible paths
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', '@a2a-bsv', 'core', 'dist', 'index.js'),
    path.resolve(__dirname, '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
    path.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'dist', 'index.js'),
  ];
  for (const p of candidates) {
    try {
      core = await import(p);
      break;
    } catch { /* next */ }
  }
  if (!core) {
    console.log = _origLog;
    console.log(JSON.stringify({ success: false, error: 'Cannot find @a2a-bsv/core. Run setup.sh first.' }));
    process.exit(1);
  }
}
const { BSVAgentWallet } = core;

// Resolve @bsv/sdk
let sdk;
try {
  sdk = await import('@bsv/sdk');
} catch {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
    path.resolve(__dirname, '..', '..', '..', 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
    path.resolve(os.homedir(), 'a2a-bsv', 'packages', 'core', 'node_modules', '@bsv', 'sdk', 'dist', 'esm', 'mod.js'),
  ];
  for (const p of candidates) {
    try {
      sdk = await import(p);
      break;
    } catch { /* next */ }
  }
  if (!sdk) {
    console.log = _origLog;
    console.log(JSON.stringify({ success: false, error: 'Cannot find @bsv/sdk. Run setup.sh first.' }));
    process.exit(1);
  }
}

// Restore console.log
console.log = _origLog;

const { PrivateKey, PublicKey, Hash, Utils, Transaction, Script, P2PKH, Beef, MerklePath, Signature } = sdk;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const WALLET_DIR = process.env.BSV_WALLET_DIR
  || path.join(os.homedir(), '.clawdbot', 'bsv-wallet');
const NETWORK = process.env.BSV_NETWORK || 'mainnet';
const OVERLAY_URL = process.env.OVERLAY_URL || 'http://162.243.168.235:8080';
const OVERLAY_STATE_DIR = path.join(os.homedir(), '.clawdbot', 'bsv-overlay');
const PROTOCOL_ID = 'clawdbot-overlay-v1';
const TOPICS = { IDENTITY: 'tm_clawdbot_identity', SERVICES: 'tm_clawdbot_services' };
const LOOKUP_SERVICES = { AGENTS: 'ls_clawdbot_agents', SERVICES: 'ls_clawdbot_services' };

// ---------------------------------------------------------------------------
// JSON output helpers
// ---------------------------------------------------------------------------
function ok(data) {
  console.log(JSON.stringify({ success: true, data }));
  process.exit(0);
}
function fail(error) {
  console.log(JSON.stringify({ success: false, error: String(error) }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Overlay helpers
// ---------------------------------------------------------------------------

/** Build an OP_FALSE OP_RETURN script with protocol prefix + JSON payload. */
function buildOpReturnScript(payload) {
  const protocolBytes = Array.from(new TextEncoder().encode(PROTOCOL_ID));
  const jsonBytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)));
  const script = new Script();
  script.writeOpCode(0x00); // OP_FALSE
  script.writeOpCode(0x6a); // OP_RETURN
  script.writeBin(protocolBytes);
  script.writeBin(jsonBytes);
  return script;
}

/** Submit BEEF to the overlay. */
async function submitToOverlay(beefData, topics) {
  const url = `${OVERLAY_URL}/submit`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Topics': JSON.stringify(topics),
    },
    body: new Uint8Array(beefData),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Overlay submit failed (${response.status}): ${body}`);
  }
  return await response.json();
}

/** Query the overlay via lookup service. */
async function lookupOverlay(service, query = {}) {
  const url = `${OVERLAY_URL}/lookup`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, query }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Overlay lookup failed (${response.status}): ${body}`);
  }
  return await response.json();
}

/** Parse a Clawdbot OP_RETURN output from BEEF data. */
function parseOverlayOutput(beef, outputIndex) {
  try {
    const tx = Transaction.fromBEEF(beef);
    const output = tx.outputs[outputIndex];
    if (!output?.lockingScript) return null;

    const chunks = output.lockingScript.chunks;
    let pushes = null;

    // Legacy 4+ chunk format
    if (chunks.length >= 4 && chunks[0].op === 0x00 && chunks[1].op === 0x6a) {
      pushes = [];
      for (let i = 2; i < chunks.length; i++) {
        if (chunks[i].data) pushes.push(new Uint8Array(chunks[i].data));
      }
    }
    // Collapsed 2-chunk format (SDK v1.10+)
    else if (chunks.length === 2 && chunks[0].op === 0x00 && chunks[1].op === 0x6a && chunks[1].data) {
      const blob = chunks[1].data;
      pushes = [];
      let pos = 0;
      while (pos < blob.length) {
        const op = blob[pos++];
        if (op > 0 && op <= 75) {
          const end = Math.min(pos + op, blob.length);
          pushes.push(new Uint8Array(blob.slice(pos, end)));
          pos = end;
        } else if (op === 0x4c) {
          const len = blob[pos++] ?? 0;
          const end = Math.min(pos + len, blob.length);
          pushes.push(new Uint8Array(blob.slice(pos, end)));
          pos = end;
        } else if (op === 0x4d) {
          const len = (blob[pos] ?? 0) | ((blob[pos + 1] ?? 0) << 8);
          pos += 2;
          const end = Math.min(pos + len, blob.length);
          pushes.push(new Uint8Array(blob.slice(pos, end)));
          pos = end;
        } else {
          break;
        }
      }
      if (pushes.length < 2) pushes = null;
    }

    if (!pushes || pushes.length < 2) return null;

    const protocolStr = new TextDecoder().decode(pushes[0]);
    if (protocolStr !== PROTOCOL_ID) return null;

    return JSON.parse(new TextDecoder().decode(pushes[1]));
  } catch {
    return null;
  }
}

/**
 * Build an OP_RETURN overlay transaction using the real funded wallet.
 *
 * Strategy: manually construct the transaction using a real UTXO from the
 * wallet's on-chain holdings, sign it, build BEEF with merkle proof, and
 * import the change output back into the wallet.
 *
 * Falls back to synthetic funding (scripts-only mode) if wallet has no balance.
 */
async function buildRealOverlayTransaction(payload, topic) {
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) {
    throw new Error('Wallet not initialized. Run: overlay-cli setup');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const pubKey = privKey.toPublicKey();

  // Derive the wallet's P2PKH address
  const pubKeyBytes = pubKey.encode(true);
  const hash160 = Hash.hash160(pubKeyBytes);
  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const addrPayload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(addrPayload)).slice(0, 4);
  const addressBytes = new Uint8Array([...addrPayload, ...checksum]);
  const walletAddress = Utils.toBase58(Array.from(addressBytes));

  // Try to get a real UTXO from WhatsonChain
  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;

  let utxos = [];
  try {
    const resp = await fetch(`${wocBase}/address/${walletAddress}/unspent`);
    if (resp.ok) utxos = await resp.json();
  } catch { /* fallback to synthetic */ }

  // Filter out dust — need at least enough for fee
  utxos = utxos.filter(u => u.value >= 200);

  if (utxos.length > 0) {
    // === REAL FUNDED TRANSACTION ===
    return await buildRealFundedTx(payload, topic, utxos[0], privKey, pubKey, hash160, walletAddress, wocBase);
  }

  // === FALLBACK: Try wallet's internal createAction ===
  // This works if the wallet DB has spendable outputs
  try {
    return await buildWalletCreateActionTx(payload, topic, identity);
  } catch (walletErr) {
    // Last resort: synthetic funding (works with SCRIPTS_ONLY=true on overlay)
    return buildSyntheticTx(payload, privKey, pubKey);
  }
}

/** Build a real funded transaction using WoC UTXO */
async function buildRealFundedTx(payload, topic, utxo, privKey, pubKey, hash160, walletAddress, wocBase) {
  // Fetch raw source tx
  const rawResp = await fetch(`${wocBase}/tx/${utxo.tx_hash}/hex`);
  if (!rawResp.ok) throw new Error(`Failed to fetch source tx: ${rawResp.status}`);
  const rawTxHex = await rawResp.text();
  const sourceTx = Transaction.fromHex(rawTxHex);

  // Fetch merkle proof for the source tx
  const txInfoResp = await fetch(`${wocBase}/tx/${utxo.tx_hash}`);
  const txInfo = await txInfoResp.json();
  const blockHeight = txInfo.blockheight;

  if (blockHeight && txInfo.confirmations > 0) {
    const proofResp = await fetch(`${wocBase}/tx/${utxo.tx_hash}/proof/tsc`);
    if (proofResp.ok) {
      const proofData = await proofResp.json();
      if (Array.isArray(proofData) && proofData.length > 0) {
        const proof = proofData[0];
        const mpPath = buildMerklePathFromTSC(utxo.tx_hash, proof.index, proof.nodes, blockHeight);
        sourceTx.merklePath = mpPath;
      }
    }
  }

  // Build the OP_RETURN transaction
  const opReturnScript = buildOpReturnScript(payload);

  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: utxo.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
    sequence: 0xffffffff,
  });

  // OP_RETURN output (0 sats)
  tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 });

  // Change output back to our address
  const pubKeyHashArr = Array.from(hash160);
  const fee = 200; // generous fee for a small tx
  const changeSats = utxo.value - fee;
  if (changeSats > 0) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(pubKeyHashArr),
      satoshis: changeSats,
    });
  }

  await tx.sign();
  const beef = tx.toBEEF();
  const txid = tx.id('hex');

  // Submit to overlay
  const steak = await submitToOverlay(beef, [topic]);

  // Import the change output back into the wallet (if it exists)
  if (changeSats > 0) {
    try {
      await importChangeOutput(txid, tx, changeSats, 1);
    } catch (importErr) {
      // Non-fatal — change will be picked up by WoC next time
    }
  }

  return { txid, beef, steak, funded: 'real', changeSats };
}

/** Build merkle path from TSC proof data */
function buildMerklePathFromTSC(txid, txIndex, nodes, blockHeight) {
  const treeHeight = nodes.length;
  const mpPath = [];

  // Level 0
  const level0 = [{ offset: txIndex, hash: txid, txid: true }];
  if (nodes[0] === '*') {
    level0.push({ offset: txIndex ^ 1, duplicate: true });
  } else {
    level0.push({ offset: txIndex ^ 1, hash: nodes[0] });
  }
  level0.sort((a, b) => a.offset - b.offset);
  mpPath.push(level0);

  // Higher levels
  for (let i = 1; i < treeHeight; i++) {
    const siblingOffset = (txIndex >> i) ^ 1;
    if (nodes[i] === '*') {
      mpPath.push([{ offset: siblingOffset, duplicate: true }]);
    } else {
      mpPath.push([{ offset: siblingOffset, hash: nodes[i] }]);
    }
  }

  return new MerklePath(blockHeight, mpPath);
}

/** Import a change output back into the wallet */
async function importChangeOutput(txid, tx, changeSats, vout) {
  try {
    const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
    const identityKey = await wallet.getIdentityKey();

    // Build a minimal BEEF for the change output
    const beef = new Beef();
    beef.mergeTransaction(tx);
    const atomicBeefBytes = beef.toBinaryAtomic(txid);

    await wallet._setup.wallet.storage.internalizeAction({
      tx: atomicBeefBytes,
      outputs: [{
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: Utils.toBase64(Array.from(new TextEncoder().encode('overlay-change'))),
          derivationSuffix: Utils.toBase64(Array.from(new TextEncoder().encode(txid.slice(0, 16)))),
          senderIdentityKey: identityKey,
        },
      }],
      description: 'Overlay tx change',
    });
    await wallet.destroy();
  } catch {
    // Non-fatal
  }
}

/** Try building via wallet's createAction (internal DB funding) */
async function buildWalletCreateActionTx(payload, topic, identity) {
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const balance = await wallet.getBalance();
  if (balance < 100) {
    await wallet.destroy();
    throw new Error(`Insufficient wallet balance (${balance} sats)`);
  }

  const opReturnScript = buildOpReturnScript(payload);

  try {
    const result = await wallet._setup.wallet.createAction({
      description: 'Overlay registration',
      outputs: [{
        lockingScript: opReturnScript.toHex(),
        satoshis: 0,
        outputDescription: 'Agent overlay data',
      }],
      options: {
        returnBEEF: true,
      },
    });

    await wallet.destroy();

    if (!result.tx) {
      throw new Error('createAction returned no transaction');
    }

    const beef = Array.from(result.tx);
    const steak = await submitToOverlay(beef, [topic]);
    const parsedBeef = Beef.fromBinary(result.tx);
    const lastTx = parsedBeef.txs[parsedBeef.txs.length - 1];
    const txid = lastTx.txid;

    return { txid, beef, steak, funded: 'wallet-internal' };
  } catch (err) {
    await wallet.destroy();
    throw err;
  }
}

/** Synthetic (unfunded) transaction — works only with SCRIPTS_ONLY overlay */
function buildSyntheticTx(payload, privKey, pubKey) {
  const pubKeyHashHex = pubKey.toHash('hex');
  const pubKeyHash = [];
  for (let i = 0; i < pubKeyHashHex.length; i += 2) {
    pubKeyHash.push(parseInt(pubKeyHashHex.substring(i, i + 2), 16));
  }

  // Synthetic funding tx
  const fundingTx = new Transaction();
  fundingTx.addOutput({
    lockingScript: new P2PKH().lock(pubKeyHash),
    satoshis: 1000,
  });

  const fundingTxid = fundingTx.id('hex');
  const siblingHash = Hash.sha256(Array.from(new TextEncoder().encode(fundingTxid)));
  const siblingHex = Array.from(siblingHash).map(b => b.toString(16).padStart(2, '0')).join('');
  fundingTx.merklePath = new MerklePath(1, [[
    { offset: 0, hash: fundingTxid, txid: true },
    { offset: 1, hash: siblingHex },
  ]]);

  const opReturnScript = buildOpReturnScript(payload);
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: opReturnScript, satoshis: 0 });
  tx.sign();

  const beef = tx.toBEEF();
  const txid = tx.id('hex');
  return { txid, beef, funded: 'synthetic' };
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------
function loadRegistration() {
  const regFile = path.join(OVERLAY_STATE_DIR, 'registration.json');
  if (fs.existsSync(regFile)) {
    return JSON.parse(fs.readFileSync(regFile, 'utf-8'));
  }
  return null;
}

function saveRegistration(data) {
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
  const regFile = path.join(OVERLAY_STATE_DIR, 'registration.json');
  fs.writeFileSync(regFile, JSON.stringify(data, null, 2), 'utf-8');
}

function loadServices() {
  const svcFile = path.join(OVERLAY_STATE_DIR, 'services.json');
  if (fs.existsSync(svcFile)) {
    return JSON.parse(fs.readFileSync(svcFile, 'utf-8'));
  }
  return [];
}

function saveServices(services) {
  fs.mkdirSync(OVERLAY_STATE_DIR, { recursive: true });
  const svcFile = path.join(OVERLAY_STATE_DIR, 'services.json');
  fs.writeFileSync(svcFile, JSON.stringify(services, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Wallet commands (adapted from bsv-agent-cli.mjs)
// ---------------------------------------------------------------------------

async function cmdSetup() {
  if (fs.existsSync(path.join(WALLET_DIR, 'wallet-identity.json'))) {
    const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
    const identityKey = await wallet.getIdentityKey();
    await wallet.destroy();
    return ok({
      identityKey,
      walletDir: WALLET_DIR,
      network: NETWORK,
      overlayUrl: OVERLAY_URL,
      alreadyExisted: true,
    });
  }
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  const wallet = await BSVAgentWallet.create({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();
  await wallet.destroy();
  ok({
    identityKey,
    walletDir: WALLET_DIR,
    network: NETWORK,
    overlayUrl: OVERLAY_URL,
    alreadyExisted: false,
  });
}

async function cmdIdentity() {
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();
  await wallet.destroy();
  ok({ identityKey });
}

async function cmdAddress() {
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const pubKey = privKey.toPublicKey();
  const pubKeyBytes = pubKey.encode(true);
  const hash160 = Hash.hash160(pubKeyBytes);

  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const payload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(payload)).slice(0, 4);
  const addressBytes = new Uint8Array([...payload, ...checksum]);
  const address = Utils.toBase58(Array.from(addressBytes));

  ok({
    address,
    network: NETWORK,
    identityKey: identity.identityKey,
    note: NETWORK === 'mainnet'
      ? `Fund this address at an exchange — Explorer: https://whatsonchain.com/address/${address}`
      : `Fund via faucet: https://witnessonchain.com/faucet/tbsv — Explorer: https://test.whatsonchain.com/address/${address}`,
  });
}

async function cmdBalance() {
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const total = await wallet.getBalance();
  await wallet.destroy();

  // Also check on-chain balance via WoC for completeness
  let onChain = null;
  try {
    const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
    const privKey = PrivateKey.fromHex(identity.rootKeyHex);
    const pubKey = privKey.toPublicKey();
    const pubKeyBytes = pubKey.encode(true);
    const hash160 = Hash.hash160(pubKeyBytes);
    const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
    const payload = new Uint8Array([prefix, ...hash160]);
    const checksum = Hash.hash256(Array.from(payload)).slice(0, 4);
    const addressBytes = new Uint8Array([...payload, ...checksum]);
    const address = Utils.toBase58(Array.from(addressBytes));

    const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
    const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/${wocNet}/address/${address}/balance`);
    if (resp.ok) {
      const bal = await resp.json();
      onChain = {
        address,
        confirmed: bal.confirmed,
        unconfirmed: bal.unconfirmed,
      };
    }
  } catch { /* non-fatal */ }

  ok({ walletBalance: total, onChain });
}

async function cmdImport(txidArg, voutStr) {
  if (!txidArg) return fail('Usage: import <txid> [vout]');
  const vout = parseInt(voutStr || '0', 10);
  const txid = txidArg.toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(txid)) return fail('Invalid txid — must be 64 hex characters');

  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;

  // Check confirmation status
  const txInfoResp = await fetch(`${wocBase}/tx/${txid}`);
  if (!txInfoResp.ok) return fail(`Failed to fetch tx info: ${txInfoResp.status}`);
  const txInfo = await txInfoResp.json();

  if (!txInfo.confirmations || txInfo.confirmations < 1) {
    return fail(`Transaction ${txid} is unconfirmed (${txInfo.confirmations || 0} confirmations). Wait for 1+ confirmation.`);
  }
  const blockHeight = txInfo.blockheight;

  // Fetch raw tx
  const rawTxResp = await fetch(`${wocBase}/tx/${txid}/hex`);
  if (!rawTxResp.ok) return fail(`Failed to fetch raw tx: ${rawTxResp.status}`);
  const rawTxHex = await rawTxResp.text();
  const sourceTx = Transaction.fromHex(rawTxHex);
  const output = sourceTx.outputs[vout];
  if (!output) return fail(`Output index ${vout} not found (tx has ${sourceTx.outputs.length} outputs)`);

  // Fetch TSC merkle proof
  const proofResp = await fetch(`${wocBase}/tx/${txid}/proof/tsc`);
  if (!proofResp.ok) return fail(`Failed to fetch merkle proof: ${proofResp.status}`);
  const proofData = await proofResp.json();
  if (!Array.isArray(proofData) || proofData.length === 0) return fail('No merkle proof available');

  const proof = proofData[0];
  const merklePath = buildMerklePathFromTSC(txid, proof.index, proof.nodes, blockHeight);
  sourceTx.merklePath = merklePath;

  const beef = new Beef();
  beef.mergeTransaction(sourceTx);
  const atomicBeefBytes = beef.toBinaryAtomic(txid);

  // Import into wallet
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const identityKey = await wallet.getIdentityKey();

  try {
    await wallet._setup.wallet.storage.internalizeAction({
      tx: atomicBeefBytes,
      outputs: [{
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: Utils.toBase64(Array.from(new TextEncoder().encode('imported'))),
          derivationSuffix: Utils.toBase64(Array.from(new TextEncoder().encode(txid.slice(0, 16)))),
          senderIdentityKey: identityKey,
        },
      }],
      description: 'External funding import',
    });

    const balance = await wallet.getBalance();
    await wallet.destroy();

    const explorerBase = NETWORK === 'mainnet' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com';
    ok({
      txid, vout,
      satoshis: output.satoshis,
      blockHeight,
      confirmations: txInfo.confirmations,
      imported: true,
      balance,
      explorer: `${explorerBase}/tx/${txid}`,
    });
  } catch (err) {
    await wallet.destroy();
    fail(`Failed to import UTXO: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdRefund(targetAddress) {
  if (!targetAddress) return fail('Usage: refund <address>');

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: setup');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));

  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const pubKey = privKey.toPublicKey();
  const pubKeyBytes = pubKey.encode(true);
  const hash160 = Hash.hash160(pubKeyBytes);
  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const payload = new Uint8Array([prefix, ...hash160]);
  const checksum = Hash.hash256(Array.from(payload)).slice(0, 4);
  const addressBytes = new Uint8Array([...payload, ...checksum]);
  const sourceAddress = Utils.toBase58(Array.from(addressBytes));

  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;

  const utxoResp = await fetch(`${wocBase}/address/${sourceAddress}/unspent`);
  if (!utxoResp.ok) return fail(`Failed to fetch UTXOs: ${utxoResp.status}`);
  const utxos = await utxoResp.json();
  if (!utxos || utxos.length === 0) return fail(`No UTXOs found for ${sourceAddress}`);

  const sourceTxCache = {};
  for (const utxo of utxos) {
    if (!sourceTxCache[utxo.tx_hash]) {
      const txResp = await fetch(`${wocBase}/tx/${utxo.tx_hash}/hex`);
      if (!txResp.ok) return fail(`Failed to fetch source tx ${utxo.tx_hash}`);
      sourceTxCache[utxo.tx_hash] = await txResp.text();
    }
  }

  const tx = new Transaction();
  let totalInput = 0;
  for (const utxo of utxos) {
    const srcTx = Transaction.fromHex(sourceTxCache[utxo.tx_hash]);
    tx.addInput({
      sourceTransaction: srcTx,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(privKey),
    });
    totalInput += utxo.value;
  }

  const targetDecoded = Utils.fromBase58(targetAddress);
  const targetHash160 = targetDecoded.slice(1, 21);
  tx.addOutput({
    lockingScript: new P2PKH().lock(targetHash160),
    satoshis: totalInput,
  });

  const estimatedSize = utxos.length * 148 + 34 + 10;
  const fee = Math.max(Math.ceil(estimatedSize / 1000), 100);
  if (totalInput <= fee) return fail(`Total value (${totalInput} sats) ≤ fee (${fee} sats)`);
  tx.outputs[0].satoshis = totalInput - fee;

  await tx.sign();
  const rawTxHex = tx.toHex();
  const txid = tx.id('hex');

  const broadcastResp = await fetch(`${wocBase}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawTxHex }),
  });

  if (!broadcastResp.ok) {
    const errText = await broadcastResp.text();
    return fail(`Broadcast failed: ${broadcastResp.status} — ${errText}`);
  }
  const broadcastResult = await broadcastResp.text();
  const explorerBase = NETWORK === 'mainnet' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com';

  ok({
    txid: broadcastResult.replace(/"/g, '').trim(),
    satoshisSent: totalInput - fee,
    fee, inputCount: utxos.length, totalInput,
    from: sourceAddress, to: targetAddress,
    network: NETWORK,
    explorer: `${explorerBase}/tx/${txid}`,
  });
}

// ---------------------------------------------------------------------------
// Payment commands
// ---------------------------------------------------------------------------

/**
 * Build a direct P2PKH payment using on-chain UTXOs.
 * Bypasses wallet-toolbox's internal UTXO management which doesn't work
 * with externally funded P2PKH addresses.
 */
async function buildDirectPayment(recipientPubKey, sats, desc) {
  // Validate recipient pubkey format
  if (!/^0[23][0-9a-fA-F]{64}$/.test(recipientPubKey)) {
    throw new Error('Recipient must be a compressed public key (66 hex chars starting with 02 or 03)');
  }

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) {
    throw new Error('Wallet not initialized. Run: overlay-cli setup');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  const senderPubKey = privKey.toPublicKey();
  const senderIdentityKey = identity.identityKey;

  // Derive sender's P2PKH address
  const senderPubKeyBytes = senderPubKey.encode(true);
  const senderHash160 = Hash.hash160(senderPubKeyBytes);
  const prefix = NETWORK === 'mainnet' ? 0x00 : 0x6f;
  const addrPayload = new Uint8Array([prefix, ...senderHash160]);
  const checksum = Hash.hash256(Array.from(addrPayload)).slice(0, 4);
  const addressBytes = new Uint8Array([...addrPayload, ...checksum]);
  const senderAddress = Utils.toBase58(Array.from(addressBytes));

  // Derive recipient's P2PKH hash from their public key
  const recipientPubKeyObj = PublicKey.fromString(recipientPubKey);
  const recipientPubKeyBytes = recipientPubKeyObj.encode(true);
  const recipientHash160 = Hash.hash160(recipientPubKeyBytes);

  // Fetch UTXOs from WhatsonChain
  const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
  const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;

  const utxoResp = await fetch(`${wocBase}/address/${senderAddress}/unspent`);
  if (!utxoResp.ok) throw new Error(`Failed to fetch UTXOs: ${utxoResp.status}`);
  const allUtxos = await utxoResp.json();

  // Filter for usable UTXOs (need enough for payment + fee)
  const minRequired = sats + 200; // payment + estimated fee
  const utxos = allUtxos.filter(u => u.value >= minRequired);
  if (utxos.length === 0) {
    const totalAvailable = allUtxos.reduce((sum, u) => sum + u.value, 0);
    throw new Error(`Insufficient funds. Need ${minRequired} sats, have ${totalAvailable} sats available.`);
  }

  const utxo = utxos[0]; // Use first sufficient UTXO

  // Fetch source transaction
  const rawResp = await fetch(`${wocBase}/tx/${utxo.tx_hash}/hex`);
  if (!rawResp.ok) throw new Error(`Failed to fetch source tx: ${rawResp.status}`);
  const rawTxHex = await rawResp.text();
  const sourceTx = Transaction.fromHex(rawTxHex);

  // Fetch merkle proof for source tx
  const txInfoResp = await fetch(`${wocBase}/tx/${utxo.tx_hash}`);
  const txInfo = await txInfoResp.json();
  const blockHeight = txInfo.blockheight;

  if (blockHeight && txInfo.confirmations > 0) {
    const proofResp = await fetch(`${wocBase}/tx/${utxo.tx_hash}/proof/tsc`);
    if (proofResp.ok) {
      const proofData = await proofResp.json();
      if (Array.isArray(proofData) && proofData.length > 0) {
        const proof = proofData[0];
        const mpPath = buildMerklePathFromTSC(utxo.tx_hash, proof.index, proof.nodes, blockHeight);
        sourceTx.merklePath = mpPath;
      }
    }
  }

  // Generate derivation info (for BRC-29 compatibility metadata)
  const derivationPrefix = Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(8))));
  const derivationSuffix = Utils.toBase64(Array.from(crypto.getRandomValues(new Uint8Array(8))));

  // Build the payment transaction
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: utxo.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(privKey),
    sequence: 0xffffffff,
  });

  // Output 0: Payment to recipient
  tx.addOutput({
    lockingScript: new P2PKH().lock(recipientHash160),
    satoshis: sats,
  });

  // Calculate fee and change
  const estimatedSize = 148 + 34 * 2 + 10; // 1 input, 2 outputs
  const fee = Math.max(Math.ceil(estimatedSize * 0.5), 50); // 0.5 sat/byte min
  const change = utxo.value - sats - fee;

  if (change < 0) {
    throw new Error(`Insufficient funds after fee. UTXO: ${utxo.value}, payment: ${sats}, fee: ${fee}`);
  }

  // Output 1: Change back to sender (if dust threshold met)
  if (change >= 136) { // P2PKH dust threshold
    tx.addOutput({
      lockingScript: new P2PKH().lock(senderHash160),
      satoshis: change,
    });
  }

  await tx.sign();

  // Build BEEF
  const beef = new Beef();
  beef.mergeTransaction(sourceTx);
  beef.mergeTransaction(tx);

  const txid = tx.id('hex');
  const atomicBeefBytes = beef.toBinaryAtomic(txid);
  const beefBase64 = Utils.toBase64(Array.from(atomicBeefBytes));

  // Broadcast the transaction
  const broadcastResp = await fetch(`${wocBase}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: tx.toHex() }),
  });

  if (!broadcastResp.ok) {
    const errText = await broadcastResp.text();
    throw new Error(`Broadcast failed: ${broadcastResp.status} — ${errText}`);
  }

  const explorerBase = NETWORK === 'mainnet' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com';

  return {
    beef: beefBase64,
    txid,
    satoshis: sats,
    fee,
    derivationPrefix,
    derivationSuffix,
    senderIdentityKey,
    recipientIdentityKey: recipientPubKey,
    broadcast: true,
    explorer: `${explorerBase}/tx/${txid}`,
  };
}

async function cmdPay(pubkey, satoshis, description) {
  if (!pubkey || !satoshis) return fail('Usage: pay <pubkey> <satoshis> [description]');
  const sats = parseInt(satoshis, 10);
  if (isNaN(sats) || sats <= 0) return fail('satoshis must be a positive integer');

  try {
    const payment = await buildDirectPayment(pubkey, sats, description || 'agent payment');
    ok(payment);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function cmdVerify(beefBase64) {
  if (!beefBase64) return fail('Usage: verify <beef_base64>');
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const result = wallet.verifyPayment({ beef: beefBase64 });
  await wallet.destroy();
  ok(result);
}

async function cmdAccept(beef, derivationPrefix, derivationSuffix, senderIdentityKey, description) {
  if (!beef || !derivationPrefix || !derivationSuffix || !senderIdentityKey) {
    return fail('Usage: accept <beef> <prefix> <suffix> <senderKey> [description]');
  }
  const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
  const receipt = await wallet.acceptPayment({
    beef, derivationPrefix, derivationSuffix, senderIdentityKey,
    description: description || undefined,
  });
  await wallet.destroy();
  ok(receipt);
}

// ---------------------------------------------------------------------------
// Overlay commands
// ---------------------------------------------------------------------------

async function cmdRegister() {
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: overlay-cli setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const identityKey = identity.identityKey;

  // Determine agent name
  const agentName = process.env.AGENT_NAME || os.hostname() || 'clawdbot-agent';
  const agentDesc = process.env.AGENT_DESCRIPTION
    || `Clawdbot agent (${agentName}). Offers services for BSV micropayments.`;

  // --- Step 1: Register identity ---
  const identityPayload = {
    protocol: PROTOCOL_ID,
    type: 'identity',
    identityKey,
    name: agentName,
    description: agentDesc,
    channels: { overlay: OVERLAY_URL },
    capabilities: ['jokes', 'services'],
    timestamp: new Date().toISOString(),
  };

  let identityResult;
  try {
    identityResult = await buildRealOverlayTransaction(identityPayload, TOPICS.IDENTITY);
  } catch (err) {
    return fail(`Identity registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Step 2: Register default joke service ---
  const servicePayload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey,
    serviceId: 'tell-joke',
    name: 'Random Joke',
    description: 'Get a random joke. Guaranteed to be at least mildly amusing.',
    pricing: { model: 'per-task', amountSats: 5 },
    timestamp: new Date().toISOString(),
  };

  let serviceResult;
  try {
    // For synthetic, we need a fresh tx. For real funding, we might need to wait
    // for the previous change to be available. Build synthetic for the service if needed.
    serviceResult = await buildRealOverlayTransaction(servicePayload, TOPICS.SERVICES);
  } catch (err) {
    // Service registration is non-fatal — identity is the important one
    serviceResult = { txid: null, error: String(err) };
  }

  // Save registration state
  const registration = {
    identityKey,
    agentName,
    agentDescription: agentDesc,
    overlayUrl: OVERLAY_URL,
    identityTxid: identityResult.txid,
    serviceTxid: serviceResult?.txid || null,
    funded: identityResult.funded,
    registeredAt: new Date().toISOString(),
  };
  saveRegistration(registration);

  // Save the joke service to local services list
  if (serviceResult?.txid) {
    const services = loadServices();
    const existing = services.findIndex(s => s.serviceId === 'tell-joke');
    const svcRecord = {
      serviceId: 'tell-joke',
      name: 'Random Joke',
      description: 'Get a random joke. Guaranteed to be at least mildly amusing.',
      priceSats: 5,
      txid: serviceResult.txid,
      registeredAt: new Date().toISOString(),
    };
    if (existing >= 0) services[existing] = svcRecord;
    else services.push(svcRecord);
    saveServices(services);
  }

  ok({
    registered: true,
    agentName,
    identityKey,
    identityTxid: identityResult.txid,
    serviceTxid: serviceResult?.txid || null,
    funded: identityResult.funded,
    overlayUrl: OVERLAY_URL,
    stateFile: path.join(OVERLAY_STATE_DIR, 'registration.json'),
  });
}

async function cmdUnregister() {
  fail('unregister is not yet implemented. Remove your agent by spending the identity UTXO.');
}

async function cmdServices() {
  const services = loadServices();
  const reg = loadRegistration();
  ok({
    identityKey: reg?.identityKey || null,
    services,
    count: services.length,
  });
}

async function cmdAdvertise(serviceId, name, description, priceSats) {
  if (!serviceId || !name || !description || !priceSats) {
    return fail('Usage: advertise <serviceId> <name> <description> <priceSats>');
  }

  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) return fail('Wallet not initialized. Run: overlay-cli setup');

  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const sats = parseInt(priceSats, 10);
  if (isNaN(sats) || sats < 0) return fail('priceSats must be a non-negative integer');

  const servicePayload = {
    protocol: PROTOCOL_ID,
    type: 'service',
    identityKey: identity.identityKey,
    serviceId,
    name,
    description,
    pricing: { model: 'per-task', amountSats: sats },
    timestamp: new Date().toISOString(),
  };

  let result;
  try {
    result = await buildRealOverlayTransaction(servicePayload, TOPICS.SERVICES);
  } catch (err) {
    return fail(`Service advertisement failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Save to local services list
  const services = loadServices();
  const existing = services.findIndex(s => s.serviceId === serviceId);
  const svcRecord = {
    serviceId, name, description, priceSats: sats,
    txid: result.txid,
    registeredAt: new Date().toISOString(),
  };
  if (existing >= 0) services[existing] = svcRecord;
  else services.push(svcRecord);
  saveServices(services);

  ok({
    advertised: true,
    serviceId, name, description, priceSats: sats,
    txid: result.txid,
    funded: result.funded,
  });
}

async function cmdRemove(serviceId) {
  if (!serviceId) return fail('Usage: remove <serviceId>');

  // Remove from local list
  const services = loadServices();
  const idx = services.findIndex(s => s.serviceId === serviceId);
  if (idx < 0) return fail(`Service '${serviceId}' not found in local registry`);

  const removed = services.splice(idx, 1)[0];
  saveServices(services);

  ok({
    removed: true,
    serviceId,
    note: 'Removed from local registry. On-chain record remains until UTXO is spent.',
    previousTxid: removed.txid,
  });
}

// ---------------------------------------------------------------------------
// Discovery commands
// ---------------------------------------------------------------------------

async function cmdDiscover(args) {
  // Parse flags
  let serviceFilter = null;
  let agentFilter = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--service' && args[i + 1]) serviceFilter = args[++i];
    else if (args[i] === '--agent' && args[i + 1]) agentFilter = args[++i];
  }

  const results = { agents: [], services: [] };

  // Query agents
  if (!serviceFilter) {
    try {
      const agentQuery = agentFilter ? { name: agentFilter } : { type: 'list' };
      const agentResult = await lookupOverlay(LOOKUP_SERVICES.AGENTS, agentQuery);

      if (agentResult.outputs) {
        for (const output of agentResult.outputs) {
          const data = parseOverlayOutput(output.beef, output.outputIndex);
          if (data && data.type === 'identity') {
            let txid = null;
            try {
              const tx = Transaction.fromBEEF(output.beef);
              txid = tx.id('hex');
            } catch { /* ignore */ }
            results.agents.push({ ...data, txid });
          }
        }
      }
    } catch (err) {
      results.agentError = String(err);
    }
  }

  // Query services
  if (!agentFilter) {
    try {
      const serviceQuery = serviceFilter ? { serviceType: serviceFilter } : {};
      const serviceResult = await lookupOverlay(LOOKUP_SERVICES.SERVICES, serviceQuery);

      if (serviceResult.outputs) {
        for (const output of serviceResult.outputs) {
          const data = parseOverlayOutput(output.beef, output.outputIndex);
          if (data && data.type === 'service') {
            let txid = null;
            try {
              const tx = Transaction.fromBEEF(output.beef);
              txid = tx.id('hex');
            } catch { /* ignore */ }
            results.services.push({ ...data, txid });
          }
        }
      }
    } catch (err) {
      results.serviceError = String(err);
    }
  }

  ok({
    overlayUrl: OVERLAY_URL,
    agentCount: results.agents.length,
    serviceCount: results.services.length,
    agents: results.agents,
    services: results.services,
    ...(results.agentError && { agentError: results.agentError }),
    ...(results.serviceError && { serviceError: results.serviceError }),
  });
}

// ---------------------------------------------------------------------------
// Relay messaging helpers
// ---------------------------------------------------------------------------

/** Get our identity key and private key from wallet. */
function loadIdentity() {
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  if (!fs.existsSync(identityPath)) {
    throw new Error('Wallet not initialized. Run: overlay-cli setup');
  }
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const privKey = PrivateKey.fromHex(identity.rootKeyHex);
  return { identityKey: identity.identityKey, privKey };
}

/** Sign a relay message: ECDSA over sha256(to + type + JSON.stringify(payload)). */
function signRelayMessage(privKey, to, type, payload) {
  const preimage = to + type + JSON.stringify(payload);
  const msgHash = Hash.sha256(Array.from(new TextEncoder().encode(preimage)));
  const sig = privKey.sign(msgHash);
  return Array.from(sig.toDER()).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Verify a relay message signature. */
function verifyRelaySignature(fromKey, to, type, payload, signatureHex) {
  if (!signatureHex) return { valid: false, reason: 'no signature' };
  try {
    const preimage = to + type + JSON.stringify(payload);
    const msgHash = Hash.sha256(Array.from(new TextEncoder().encode(preimage)));
    const sigBytes = [];
    for (let i = 0; i < signatureHex.length; i += 2) {
      sigBytes.push(parseInt(signatureHex.substring(i, i + 2), 16));
    }
    const sig = Signature.fromDER(sigBytes);
    const pubKey = PublicKey.fromString(fromKey);
    return { valid: pubKey.verify(msgHash, sig) };
  } catch (err) {
    return { valid: false, reason: String(err) };
  }
}

const JOKES = [
  { setup: "Why do programmers prefer dark mode?", punchline: "Because light attracts bugs." },
  { setup: "Why did the BSV go to therapy?", punchline: "It had too many unresolved transactions." },
  { setup: "How many satoshis does it take to change a lightbulb?", punchline: "None — they prefer to stay on-chain." },
  { setup: "Why don't AI agents ever get lonely?", punchline: "They're always on the overlay." },
  { setup: "What did one Clawdbot say to the other?", punchline: "I'd tell you a joke, but it'll cost you 5 sats." },
  { setup: "Why did the blockchain break up with the database?", punchline: "It needed more commitment." },
  { setup: "What's a miner's favorite type of music?", punchline: "Block and roll." },
  { setup: "Why was the transaction so confident?", punchline: "It had six confirmations." },
  { setup: "What do you call a wallet with no UTXOs?", punchline: "A sad wallet." },
  { setup: "Why did the smart contract go to school?", punchline: "To improve its execution." },
  { setup: "How do BSV nodes say goodbye?", punchline: "See you on the next block!" },
  { setup: "Why don't private keys ever get invited to parties?", punchline: "They're too secretive." },
  { setup: "What's an overlay node's favorite game?", punchline: "Peer-to-peer tag." },
  { setup: "Why did the UTXO feel special?", punchline: "Because it was unspent." },
  { setup: "What did the signature say to the hash?", punchline: "I've got you covered." },
];

// ---------------------------------------------------------------------------
// Relay messaging commands
// ---------------------------------------------------------------------------

async function cmdSend(targetKey, type, payloadStr) {
  if (!targetKey || !type || !payloadStr) {
    return fail('Usage: send <identityKey> <type> <json_payload>');
  }
  if (!/^0[23][0-9a-fA-F]{64}$/.test(targetKey)) {
    return fail('Target must be a compressed public key (66 hex chars, 02/03 prefix)');
  }

  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return fail('payload must be valid JSON');
  }

  const { identityKey, privKey } = loadIdentity();
  const signature = signRelayMessage(privKey, targetKey, type, payload);

  const resp = await fetch(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey,
      to: targetKey,
      type,
      payload,
      signature,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    return fail(`Relay send failed (${resp.status}): ${body}`);
  }
  const result = await resp.json();
  ok({ sent: true, messageId: result.id, to: targetKey, type, signed: true });
}

async function cmdInbox(args) {
  const { identityKey } = loadIdentity();
  let since = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since' && args[i + 1]) since = `&since=${args[++i]}`;
  }

  const resp = await fetch(`${OVERLAY_URL}/relay/inbox?identity=${identityKey}${since}`);
  if (!resp.ok) {
    const body = await resp.text();
    return fail(`Relay inbox failed (${resp.status}): ${body}`);
  }
  const result = await resp.json();

  // Verify signatures on received messages
  const messages = result.messages.map(msg => ({
    ...msg,
    signatureValid: msg.signature
      ? verifyRelaySignature(msg.from, msg.to, msg.type, msg.payload, msg.signature).valid
      : null,
  }));

  ok({ messages, count: messages.length, identityKey });
}

async function cmdAck(messageIds) {
  if (!messageIds || messageIds.length === 0) {
    return fail('Usage: ack <messageId> [messageId2 ...]');
  }
  const { identityKey } = loadIdentity();

  const resp = await fetch(`${OVERLAY_URL}/relay/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: identityKey, messageIds }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    return fail(`Relay ack failed (${resp.status}): ${body}`);
  }
  const result = await resp.json();
  ok({ acked: result.acked, messageIds });
}

// ---------------------------------------------------------------------------
// Shared message processing — used by both poll and connect (WebSocket)
// ---------------------------------------------------------------------------

/**
 * Process a single relay message. Handles pings, joke service requests,
 * pongs, service responses. Returns a result object.
 *
 * result.ack — whether the message should be ACKed
 * result.id  — the message id
 */
async function processMessage(msg, identityKey, privKey) {
  // Verify signature if present
  const sigCheck = msg.signature
    ? verifyRelaySignature(msg.from, msg.to, msg.type, msg.payload, msg.signature)
    : { valid: null };

  if (msg.type === 'ping') {
    // Auto-respond with pong
    const pongPayload = {
      text: 'pong',
      inReplyTo: msg.id,
      originalText: msg.payload?.text || null,
    };
    const pongSig = signRelayMessage(privKey, msg.from, 'pong', pongPayload);
    await fetch(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: identityKey,
        to: msg.from,
        type: 'pong',
        payload: pongPayload,
        signature: pongSig,
      }),
    });
    return { id: msg.id, type: 'ping', action: 'replied-pong', from: msg.from, ack: true };

  } else if (msg.type === 'service-request') {
    const serviceId = msg.payload?.serviceId;
    if (serviceId === 'tell-joke') {
      return await processJokeRequest(msg, identityKey, privKey);
    } else {
      // Unknown service — don't auto-process
      return {
        id: msg.id, type: 'service-request', serviceId,
        from: msg.from, signatureValid: sigCheck.valid,
        action: 'unhandled', ack: false,
      };
    }

  } else if (msg.type === 'pong') {
    return {
      id: msg.id, type: 'pong', action: 'received', from: msg.from,
      text: msg.payload?.text, inReplyTo: msg.payload?.inReplyTo, ack: true,
    };

  } else if (msg.type === 'service-response') {
    return {
      id: msg.id, type: 'service-response', action: 'received', from: msg.from,
      serviceId: msg.payload?.serviceId, status: msg.payload?.status,
      result: msg.payload?.result, requestId: msg.payload?.requestId, ack: true,
    };

  } else {
    // Unknown type
    return {
      id: msg.id, type: msg.type, from: msg.from,
      payload: msg.payload, signatureValid: sigCheck.valid,
      action: 'unhandled', ack: false,
    };
  }
}

/** Handle a tell-joke service request with payment verification. */
async function processJokeRequest(msg, identityKey, privKey) {
  const payment = msg.payload?.payment;

  // Helper to send rejection
  async function reject(reason, shortReason) {
    const rejectPayload = {
      requestId: msg.id, serviceId: 'tell-joke', status: 'rejected', reason,
    };
    const rejectSig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetch(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: identityKey, to: msg.from, type: 'service-response',
        payload: rejectPayload, signature: rejectSig,
      }),
    });
    return {
      id: msg.id, type: 'service-request', serviceId: 'tell-joke',
      action: 'rejected', reason: shortReason, from: msg.from, ack: true,
    };
  }

  if (!payment || !payment.beef || !payment.satoshis) {
    return reject('No payment included. This service costs 5 sats.', 'no payment');
  }
  if (payment.satoshis < 5) {
    return reject(
      `Insufficient payment: ${payment.satoshis} sats sent, 5 required.`,
      `underpaid: ${payment.satoshis} < 5`,
    );
  }

  // Decode BEEF
  let beefBytes;
  try {
    beefBytes = Uint8Array.from(atob(payment.beef), c => c.charCodeAt(0));
  } catch { beefBytes = null; }

  if (!beefBytes || beefBytes.length < 20) {
    return reject('Invalid payment BEEF. Could not decode base64.', 'invalid base64');
  }

  // Parse the payment transaction
  let paymentTx = null;
  let isAtomicBeef = false;
  try { paymentTx = Transaction.fromAtomicBEEF(Array.from(beefBytes)); isAtomicBeef = true; } catch {}
  if (!paymentTx) {
    try {
      const beefObj = Beef.fromBinary(Array.from(beefBytes));
      const txs = beefObj.txs || [];
      const newest = txs.find(t => t.tx) || txs[txs.length - 1];
      paymentTx = newest?.tx || null;
    } catch {}
  }
  if (!paymentTx) {
    return reject('Invalid payment BEEF. Could not parse transaction.', 'unparseable BEEF');
  }

  // Find the output that pays us
  const identityPath = path.join(WALLET_DIR, 'wallet-identity.json');
  const walletIdentity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
  const ourPrivKey = PrivateKey.fromHex(walletIdentity.rootKeyHex);
  const ourPubKey = ourPrivKey.toPublicKey();
  const ourHash160 = Hash.hash160(ourPubKey.encode(true));
  const ourHash160Hex = Array.from(ourHash160).map(b => b.toString(16).padStart(2, '0')).join('');

  let paymentOutputIndex = -1;
  let paymentSats = 0;
  for (let i = 0; i < paymentTx.outputs.length; i++) {
    const scriptHex = paymentTx.outputs[i].lockingScript.toHex();
    if (scriptHex.includes(ourHash160Hex)) {
      paymentOutputIndex = i;
      paymentSats = paymentTx.outputs[i].satoshis;
      break;
    }
  }
  if (paymentOutputIndex < 0) {
    return reject('No output paying our address found in the transaction.', 'no output to us');
  }
  if (paymentSats < 5) {
    return reject(`Output pays ${paymentSats} sats, minimum 5 required.`, `underpaid: ${paymentSats}`);
  }

  // Accept the payment into our wallet
  const paymentTxid = paymentTx.id('hex');
  let walletAccepted = false;
  let acceptError = null;

  const derivPrefix = payment.derivationPrefix || Utils.toBase64(Array.from(new TextEncoder().encode('service-payment')));
  const derivSuffix = payment.derivationSuffix || Utils.toBase64(Array.from(new TextEncoder().encode(paymentTxid.slice(0, 16))));
  const internalizeArgs = {
    outputs: [{
      outputIndex: paymentOutputIndex,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: derivPrefix, derivationSuffix: derivSuffix,
        senderIdentityKey: msg.from,
      },
    }],
    description: `Payment for tell-joke from ${msg.from.slice(0, 12)}...`,
  };

  // Attempt 1: use the BEEF bytes directly from sender
  try {
    const wallet = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
    let atomicBytes;
    if (isAtomicBeef) {
      atomicBytes = new Uint8Array(beefBytes);
    } else {
      const beefObj = Beef.fromBinary(Array.from(beefBytes));
      atomicBytes = beefObj.toBinaryAtomic(paymentTxid);
    }
    await wallet._setup.wallet.storage.internalizeAction({ tx: atomicBytes, ...internalizeArgs });
    await wallet.destroy();
    walletAccepted = true;
  } catch (err1) {
    // Attempt 2: rebuild BEEF from WhatsonChain
    try {
      const wocNet = NETWORK === 'mainnet' ? 'main' : 'test';
      const wocBase = `https://api.whatsonchain.com/v1/bsv/${wocNet}`;
      const txChain = [];
      let curTxid = paymentTxid;
      let curTx = paymentTx;
      txChain.push({ tx: curTx, txid: curTxid });

      for (let depth = 0; depth < 10; depth++) {
        const srcTxid = curTx.inputs[0].sourceTXID;
        const srcHexResp = await fetch(`${wocBase}/tx/${srcTxid}/hex`);
        if (!srcHexResp.ok) throw new Error(`WoC tx hex ${srcTxid.slice(0,12)}: ${srcHexResp.status}`);
        const srcHex = await srcHexResp.text();
        const srcTx = Transaction.fromHex(srcHex);

        const srcInfoResp = await fetch(`${wocBase}/tx/${srcTxid}`);
        if (!srcInfoResp.ok) throw new Error(`WoC tx info ${srcTxid.slice(0,12)}: ${srcInfoResp.status}`);
        const srcInfo = await srcInfoResp.json();

        if (srcInfo.confirmations > 0 && srcInfo.blockheight) {
          const proofResp = await fetch(`${wocBase}/tx/${srcTxid}/proof/tsc`);
          if (proofResp.ok) {
            const proofData = await proofResp.json();
            if (Array.isArray(proofData) && proofData.length > 0) {
              const proof = proofData[0];
              srcTx.merklePath = buildMerklePathFromTSC(srcTxid, proof.index, proof.nodes, srcInfo.blockheight);
            }
          }
          txChain.push({ tx: srcTx, txid: srcTxid });
          break;
        }
        txChain.push({ tx: srcTx, txid: srcTxid });
        curTx = srcTx;
        curTxid = srcTxid;
      }

      const freshBeef = new Beef();
      for (let i = txChain.length - 1; i >= 0; i--) {
        freshBeef.mergeTransaction(txChain[i].tx);
      }
      const freshAtomicBytes = new Uint8Array(freshBeef.toBinaryAtomic(paymentTxid));

      const wallet2 = await BSVAgentWallet.load({ network: NETWORK, storageDir: WALLET_DIR });
      await wallet2._setup.wallet.storage.internalizeAction({ tx: freshAtomicBytes, ...internalizeArgs });
      await wallet2.destroy();
      walletAccepted = true;
      acceptError = null;
    } catch (err2) {
      acceptError = `Attempt 1: ${err1 instanceof Error ? err1.message : String(err1)} | Attempt 2: ${err2 instanceof Error ? err2.message : String(err2)}`;
    }
  }

  // Serve the joke
  const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
  const responsePayload = {
    requestId: msg.id, serviceId: 'tell-joke', status: 'fulfilled',
    result: joke, paymentAccepted: true, paymentTxid,
    satoshisReceived: paymentSats, walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetch(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey, to: msg.from, type: 'service-response',
      payload: responsePayload, signature: respSig,
    }),
  });

  return {
    id: msg.id, type: 'service-request', serviceId: 'tell-joke',
    action: 'fulfilled', joke, paymentAccepted: true, paymentTxid,
    satoshisReceived: paymentSats, walletAccepted,
    ...(acceptError ? { walletError: acceptError } : {}),
    from: msg.from, ack: true,
  };
}

// ---------------------------------------------------------------------------
// Poll command — uses shared processMessage
// ---------------------------------------------------------------------------

async function cmdPoll() {
  const { identityKey, privKey } = loadIdentity();

  // Fetch inbox
  const inboxResp = await fetch(`${OVERLAY_URL}/relay/inbox?identity=${identityKey}`);
  if (!inboxResp.ok) {
    const body = await inboxResp.text();
    return fail(`Relay inbox failed (${inboxResp.status}): ${body}`);
  }
  const inbox = await inboxResp.json();

  if (inbox.count === 0) {
    return ok({ processed: 0, messages: [], summary: 'No pending messages.' });
  }

  const processed = [];
  const ackedIds = [];
  const unhandled = [];

  for (const msg of inbox.messages) {
    const result = await processMessage(msg, identityKey, privKey);
    if (result.ack) {
      ackedIds.push(result.id);
      processed.push(result);
    } else {
      unhandled.push(result);
    }
  }

  // ACK processed messages
  if (ackedIds.length > 0) {
    await fetch(`${OVERLAY_URL}/relay/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: identityKey, messageIds: ackedIds }),
    });
  }

  ok({
    processed: processed.length,
    unhandled: unhandled.length,
    total: inbox.count,
    messages: processed,
    unhandledMessages: unhandled,
    ackedIds,
  });
}

// ---------------------------------------------------------------------------
// Connect command — WebSocket real-time message processing
// ---------------------------------------------------------------------------

async function cmdConnect() {
  let WebSocketClient;
  try {
    const ws = await import('ws');
    WebSocketClient = ws.default || ws.WebSocket || ws;
  } catch {
    return fail('WebSocket client not available. Install it: npm install ws (in the skill directory)');
  }

  const { identityKey, privKey } = loadIdentity();
  const wsUrl = OVERLAY_URL.replace(/^http/, 'ws') + '/relay/subscribe?identity=' + identityKey;

  let reconnectDelay = 1000;
  let shouldReconnect = true;
  let currentWs = null;

  function shutdown() {
    shouldReconnect = false;
    if (currentWs) {
      try { currentWs.close(); } catch {}
    }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  function connect() {
    const ws = new WebSocketClient(wsUrl);
    currentWs = ws;

    ws.on('open', () => {
      reconnectDelay = 1000; // reset on successful connect
      console.error(JSON.stringify({ event: 'connected', identity: identityKey, overlay: OVERLAY_URL }));
    });

    ws.on('message', async (data) => {
      try {
        const envelope = JSON.parse(data.toString());
        if (envelope.type === 'message') {
          const result = await processMessage(envelope.message, identityKey, privKey);
          // Output the result as a JSON line to stdout
          console.log(JSON.stringify(result));
          // Ack the message
          if (result.ack) {
            try {
              await fetch(OVERLAY_URL + '/relay/ack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: identityKey, messageIds: [result.id] }),
              });
            } catch (ackErr) {
              console.error(JSON.stringify({ event: 'ack-error', id: result.id, message: String(ackErr) }));
            }
          }
        }
        // Ignore 'connected' type — just informational
      } catch (err) {
        console.error(JSON.stringify({ event: 'process-error', message: String(err) }));
      }
    });

    ws.on('close', () => {
      currentWs = null;
      if (shouldReconnect) {
        console.error(JSON.stringify({ event: 'disconnected', reconnectMs: reconnectDelay }));
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      }
    });

    ws.on('error', (err) => {
      console.error(JSON.stringify({ event: 'error', message: err.message }));
    });
  }

  connect();
  // Keep the process alive — never resolves
  await new Promise(() => {});
}

async function cmdRequestService(targetKey, serviceId, satsStr) {
  if (!targetKey || !serviceId) {
    return fail('Usage: request-service <identityKey> <serviceId> [sats]');
  }
  if (!/^0[23][0-9a-fA-F]{64}$/.test(targetKey)) {
    return fail('Target must be a compressed public key (66 hex chars, 02/03 prefix)');
  }

  const { identityKey, privKey } = loadIdentity();
  const sats = parseInt(satsStr || '5', 10);

  // Build the service request payload
  let paymentData = null;

  if (sats > 0) {
    try {
      const payment = await buildDirectPayment(targetKey, sats, `service-request: ${serviceId}`);
      paymentData = {
        beef: payment.beef,
        txid: payment.txid,
        satoshis: payment.satoshis,
        derivationPrefix: payment.derivationPrefix,
        derivationSuffix: payment.derivationSuffix,
        senderIdentityKey: payment.senderIdentityKey,
      };
    } catch (err) {
      // Payment failed — send request without payment
      paymentData = { error: String(err instanceof Error ? err.message : err) };
    }
  }

  const requestPayload = {
    serviceId,
    payment: paymentData,
    requestedAt: new Date().toISOString(),
  };

  const signature = signRelayMessage(privKey, targetKey, 'service-request', requestPayload);

  const resp = await fetch(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: identityKey,
      to: targetKey,
      type: 'service-request',
      payload: requestPayload,
      signature,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    return fail(`Relay send failed (${resp.status}): ${body}`);
  }
  const result = await resp.json();

  ok({
    sent: true,
    requestId: result.id,
    to: targetKey,
    serviceId,
    paymentIncluded: paymentData && !paymentData.error,
    paymentTxid: paymentData?.txid || null,
    satoshis: paymentData?.satoshis || 0,
    note: 'Poll for service-response to get the result',
  });
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------
const [,, command, ...args] = process.argv;

try {
  switch (command) {
    // Wallet
    case 'setup':     await cmdSetup(); break;
    case 'identity':  await cmdIdentity(); break;
    case 'address':   await cmdAddress(); break;
    case 'balance':   await cmdBalance(); break;
    case 'import':    await cmdImport(args[0], args[1]); break;
    case 'refund':    await cmdRefund(args[0]); break;

    // Overlay registration
    case 'register':    await cmdRegister(); break;
    case 'unregister':  await cmdUnregister(); break;

    // Services
    case 'services':    await cmdServices(); break;
    case 'advertise':   await cmdAdvertise(args[0], args[1], args[2], args[3]); break;
    case 'remove':      await cmdRemove(args[0]); break;

    // Discovery
    case 'discover':    await cmdDiscover(args); break;

    // Payments
    case 'pay':     await cmdPay(args[0], args[1], args.slice(2).join(' ') || undefined); break;
    case 'verify':  await cmdVerify(args[0]); break;
    case 'accept':  await cmdAccept(args[0], args[1], args[2], args[3], args.slice(4).join(' ') || undefined); break;

    // Messaging (relay)
    case 'send':              await cmdSend(args[0], args[1], args[2]); break;
    case 'inbox':             await cmdInbox(args); break;
    case 'ack':               await cmdAck(args); break;
    case 'poll':              await cmdPoll(); break;
    case 'connect':           await cmdConnect(); break;
    case 'request-service':   await cmdRequestService(args[0], args[1], args[2]); break;

    default:
      fail(`Unknown command: ${command || '(none)'}. Commands: setup, identity, address, balance, import, refund, register, unregister, services, advertise, remove, discover, pay, verify, accept, send, inbox, ack, poll, connect, request-service`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
