// ============================================================
// Bank-transfer receipts.
//
// While a conversation has an order awaiting payment:
//   - a document (PDF bank receipt) is taken as the receipt directly;
//   - an image is ambiguous (it may be a product photo), so we ask the
//     customer with two buttons — "Is this your payment receipt for
//     INV-0001?" — and only a "Yes" tap attaches it.
// Attaching the receipt moves the order to `payment_submitted`, thanks
// the customer, leaves an agent a note, and routes the thread to the
// account's handoff agent. Payment is never confirmed automatically —
// a human always checks the bank.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  engineSendInteractiveButtons,
  engineSendText,
} from '@/lib/flows/meta-send';
import { formatPrice } from '@/lib/currency';
import { buildPaymentProofNote, buildPaymentReceivedText } from './messages';
import { findOpenOrderForConversation, recordPaymentProof } from './store';
import type { Order } from './types';

/** Button-reply id prefixes; the inbound media message id follows. */
export const RECEIPT_YES_PREFIX = 'vs_receipt_yes:';
export const RECEIPT_NO_PREFIX = 'vs_receipt_no:';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConversationArgs {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  contactId: string;
  /** WhatsApp config owner — audit user for sends and the note. */
  configOwnerUserId: string;
}

export interface PaymentProofArgs extends ConversationArgs {
  /** Internal id of the inbound media message (messages.id). */
  messageId: string;
  contentType: 'image' | 'document';
}

export interface ReceiptReplyArgs extends ConversationArgs {
  /** The tapped button's id (`interactiveReplyId`). */
  replyId: string;
}

/** True for button replies this module owns. */
export function isReceiptReply(replyId: string | null | undefined): boolean {
  return Boolean(
    replyId &&
    (replyId.startsWith(RECEIPT_YES_PREFIX) ||
      replyId.startsWith(RECEIPT_NO_PREFIX))
  );
}

/**
 * Handle an inbound image/document while an order may be awaiting
 * payment. A no-op when the conversation has no open order. Never
 * throws — a failure here must not affect the webhook.
 */
export async function handleInboundPaymentProof(
  args: PaymentProofArgs
): Promise<void> {
  try {
    const order = await findOpenOrderForConversation(
      args.db,
      args.accountId,
      args.conversationId
    );
    if (!order) return;

    if (args.contentType === 'document') {
      await attachReceipt(args, order, args.messageId);
      return;
    }

    await engineSendInteractiveButtons({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      bodyText:
        `Is this your payment receipt for order ${order.order_number} ` +
        `(${formatPrice(Number(order.total), order.currency)})?`,
      buttons: [
        { id: `${RECEIPT_YES_PREFIX}${args.messageId}`, title: 'Yes, receipt' },
        { id: `${RECEIPT_NO_PREFIX}${args.messageId}`, title: 'No' },
      ],
    });
  } catch (err) {
    console.error('[commerce] payment proof handling failed:', err);
  }
}

/**
 * Handle the customer's tap on the "is this your receipt?" buttons.
 * The image id in the button is re-verified (it must be a customer image
 * in this conversation) before anything is attached. Never throws.
 */
export async function handleReceiptReply(
  args: ReceiptReplyArgs
): Promise<void> {
  try {
    const yes = args.replyId.startsWith(RECEIPT_YES_PREFIX);
    const messageId = args.replyId.slice(
      (yes ? RECEIPT_YES_PREFIX : RECEIPT_NO_PREFIX).length
    );
    if (!UUID_RE.test(messageId)) return;

    if (!yes) {
      await sendText(
        args,
        'No problem! Let us know if you need anything else.'
      );
      return;
    }

    const { data: image } = await args.db
      .from('messages')
      .select('id')
      .eq('id', messageId)
      .eq('conversation_id', args.conversationId)
      .eq('sender_type', 'customer')
      .eq('content_type', 'image')
      .maybeSingle();
    if (!image) return;

    const order = await findOpenOrderForConversation(
      args.db,
      args.accountId,
      args.conversationId
    );
    if (!order) return;
    await attachReceipt(args, order, messageId);
  } catch (err) {
    console.error('[commerce] receipt reply handling failed:', err);
  }
}

/** Attach the receipt, note it for an agent, route, thank the customer. */
async function attachReceipt(
  args: ConversationArgs,
  order: Order,
  messageId: string
): Promise<void> {
  const { db, accountId, conversationId, contactId, configOwnerUserId } = args;
  const recorded = await recordPaymentProof(db, accountId, order.id, messageId);
  if (!recorded) return;

  await db.from('contact_notes').insert({
    account_id: accountId,
    contact_id: contactId,
    user_id: configOwnerUserId,
    note_text: buildPaymentProofNote(order),
  });

  // Route to the handoff agent (assignment notifies them) unless a
  // human already owns the thread.
  const [{ data: aiConfig }, { data: conv }] = await Promise.all([
    db
      .from('ai_configs')
      .select('handoff_agent_id')
      .eq('account_id', accountId)
      .maybeSingle(),
    db
      .from('conversations')
      .select('assigned_agent_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle(),
  ]);
  if (aiConfig?.handoff_agent_id && conv && !conv.assigned_agent_id) {
    await db
      .from('conversations')
      .update({ assigned_agent_id: aiConfig.handoff_agent_id })
      .eq('id', conversationId)
      .eq('account_id', accountId);
  }

  await sendText(args, buildPaymentReceivedText(order));
}

function sendText(args: ConversationArgs, text: string) {
  return engineSendText({
    accountId: args.accountId,
    userId: args.configOwnerUserId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    text,
  });
}
