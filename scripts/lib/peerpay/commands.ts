/**
 * PeerPay CLI commands: send, receive, init, lookup.
 *
 * Identity-based peer-to-peer payments using BRC-29 PeerPay protocol
 * via @bsv/message-box-client.
 */

import { ok, fail } from '../output.js';
import {
  loadWallet,
  createPeerPayClient,
  isAnointed,
  markAnointed,
  DEFAULT_MESSAGE_BOX_URL,
} from './client.js';
import { lookupIdentity } from './identity.js';

/**
 * Initialize / anoint a MessageBox host (one-time setup).
 */
export async function cmdPeerPayInit(messageBoxUrl?: string): Promise<never> {
  const host = messageBoxUrl || DEFAULT_MESSAGE_BOX_URL;

  if (isAnointed(host)) {
    return ok({
      host,
      alreadyAnointed: true,
      message: `Host ${host} is already anointed.`,
    });
  }

  const wallet = await loadWallet();
  try {
    const client = await createPeerPayClient(wallet, host);
    await client.init(host);
    markAnointed(host);
    await wallet.destroy();
    return ok({
      host,
      alreadyAnointed: false,
      message: `Successfully anointed ${host}. You can now send and receive PeerPay payments.`,
    });
  } catch (err: any) {
    await wallet.destroy();
    return fail(`PeerPay init failed: ${err.message}`);
  }
}

/**
 * Look up an identity by handle or key.
 */
export async function cmdPeerPayLookup(query: string | undefined): Promise<never> {
  if (!query) {
    return fail('Usage: peerpay-lookup <handle_or_identity_key>');
  }

  const wallet = await loadWallet();
  try {
    const results = await lookupIdentity(query, wallet);
    await wallet.destroy();

    if (results.length === 0) {
      return fail(`No identities found for "${query}".`);
    }

    return ok({ query, results, count: results.length });
  } catch (err: any) {
    await wallet.destroy();
    return fail(`Identity lookup failed: ${err.message}`);
  }
}

/**
 * Send a PeerPay payment to a recipient resolved by handle or identity key.
 */
export async function cmdPeerPaySend(
  recipientQuery: string | undefined,
  satoshis: string | undefined
): Promise<never> {
  if (!recipientQuery || !satoshis) {
    return fail('Usage: peerpay-send <recipient_handle_or_key> <satoshis>');
  }

  const sats = parseInt(satoshis, 10);
  if (isNaN(sats) || sats <= 0) {
    return fail('satoshis must be a positive integer');
  }

  const host = DEFAULT_MESSAGE_BOX_URL;
  const wallet = await loadWallet();

  try {
    // Resolve identity
    const identities = await lookupIdentity(recipientQuery, wallet);
    if (identities.length === 0) {
      await wallet.destroy();
      return fail(`No identity found for "${recipientQuery}". Try a different handle or use a full identity key.`);
    }

    const recipient = identities[0];

    // Ensure host is anointed
    if (!isAnointed(host)) {
      const client = await createPeerPayClient(wallet, host);
      await client.init(host);
      markAnointed(host);
    }

    // Send payment
    const client = await createPeerPayClient(wallet, host);
    const result = await client.sendPayment({
      recipient: recipient.identityKey,
      amount: sats,
    });

    await wallet.destroy();

    return ok({
      sent: true,
      recipient: {
        identityKey: recipient.identityKey,
        handle: recipient.handle,
        displayName: recipient.displayName,
      },
      satoshis: sats,
      messageBoxHost: host,
      result,
      message: `Sent ${sats} sats to ${recipient.handle || recipient.identityKey.slice(0, 16) + '...'} via PeerPay.`,
    });
  } catch (err: any) {
    await wallet.destroy();
    return fail(`PeerPay send failed: ${err.message}`);
  }
}

/**
 * List and accept incoming PeerPay payments.
 */
export async function cmdPeerPayReceive(): Promise<never> {
  const host = DEFAULT_MESSAGE_BOX_URL;
  const wallet = await loadWallet();

  try {
    // Ensure host is anointed
    if (!isAnointed(host)) {
      const client = await createPeerPayClient(wallet, host);
      await client.init(host);
      markAnointed(host);
    }

    const client = await createPeerPayClient(wallet, host);
    const payments = await client.listIncomingPayments(host);

    if (!payments || payments.length === 0) {
      await wallet.destroy();
      return ok({
        received: 0,
        accepted: 0,
        payments: [],
        message: 'No incoming PeerPay payments found.',
      });
    }

    // Accept each payment
    const accepted: any[] = [];
    const errors: any[] = [];

    for (const payment of payments) {
      try {
        await client.acceptPayment(payment);
        accepted.push({
          from: payment.senderIdentityKey || payment.sender,
          satoshis: payment.amount || payment.satoshis,
        });
      } catch (err: any) {
        errors.push({
          from: payment.senderIdentityKey || payment.sender,
          error: err.message,
        });
      }
    }

    await wallet.destroy();

    return ok({
      received: payments.length,
      accepted: accepted.length,
      failed: errors.length,
      payments: accepted,
      errors: errors.length > 0 ? errors : undefined,
      message: `Accepted ${accepted.length} of ${payments.length} incoming payment(s).`,
    });
  } catch (err: any) {
    await wallet.destroy();
    return fail(`PeerPay receive failed: ${err.message}`);
  }
}
