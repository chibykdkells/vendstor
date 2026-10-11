import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  engineSendText: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  findOpenOrderForConversation: vi.fn(),
  recordPaymentProof: vi.fn(),
}));

vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendInteractiveButtons: h.engineSendInteractiveButtons,
}));
vi.mock('./store', () => ({
  findOpenOrderForConversation: h.findOpenOrderForConversation,
  recordPaymentProof: h.recordPaymentProof,
}));

import {
  RECEIPT_NO_PREFIX,
  RECEIPT_YES_PREFIX,
  handleInboundPaymentProof,
  handleReceiptReply,
  isReceiptReply,
} from './payment-proof';

const IMAGE_ID = '11111111-2222-3333-4444-555555555555';

const order = {
  id: 'o1',
  order_number: 'INV-0007',
  total: '16500.50',
  currency: 'NGN',
};

/** Minimal fake: records inserts/updates per table, canned reads. */
function makeDb(opts: {
  handoffAgentId?: string | null;
  assignedAgentId?: string | null;
  imageExists?: boolean;
}) {
  const inserts: Record<string, unknown[]> = {};
  const updates: Record<string, unknown[]> = {};
  const filters: Record<string, unknown[][]> = {};
  const reads: Record<string, unknown> = {
    ai_configs: { handoff_agent_id: opts.handoffAgentId ?? null },
    conversations: { assigned_agent_id: opts.assignedAgentId ?? null },
    messages: opts.imageExists === false ? null : { id: IMAGE_ID },
  };
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = (...args: unknown[]) => {
      (filters[table] ??= []).push(args);
      return c;
    };
    c.maybeSingle = () => Promise.resolve({ data: reads[table], error: null });
    c.insert = (row: unknown) => {
      (inserts[table] ??= []).push(row);
      return Promise.resolve({ error: null });
    };
    c.update = (row: unknown) => {
      (updates[table] ??= []).push(row);
      return c;
    };
    c.then = (resolve: (r: unknown) => unknown) => resolve({ error: null });
    return c;
  };
  const db = { from: chain } as unknown as SupabaseClient;
  return { db, inserts, updates, filters };
}

const base = {
  accountId: 'acct-1',
  conversationId: 'cv1',
  contactId: 'c1',
  configOwnerUserId: 'owner-1',
};

beforeEach(() => {
  vi.resetAllMocks();
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'w1' });
  h.engineSendInteractiveButtons.mockResolvedValue({
    whatsapp_message_id: 'w2',
  });
});

describe('handleInboundPaymentProof', () => {
  it('does nothing when the conversation has no open order', async () => {
    h.findOpenOrderForConversation.mockResolvedValue(null);
    const { db, inserts } = makeDb({});
    await handleInboundPaymentProof({
      db,
      ...base,
      messageId: IMAGE_ID,
      contentType: 'image',
    });
    expect(h.engineSendInteractiveButtons).not.toHaveBeenCalled();
    expect(h.recordPaymentProof).not.toHaveBeenCalled();
    expect(inserts.contact_notes).toBeUndefined();
  });

  it('asks before treating an image as a receipt', async () => {
    h.findOpenOrderForConversation.mockResolvedValue(order);
    const { db } = makeDb({});
    await handleInboundPaymentProof({
      db,
      ...base,
      messageId: IMAGE_ID,
      contentType: 'image',
    });
    expect(h.recordPaymentProof).not.toHaveBeenCalled();
    const sent = h.engineSendInteractiveButtons.mock.calls[0][0];
    expect(sent.bodyText).toContain('INV-0007');
    expect(sent.buttons).toEqual([
      { id: `${RECEIPT_YES_PREFIX}${IMAGE_ID}`, title: 'Yes, receipt' },
      { id: `${RECEIPT_NO_PREFIX}${IMAGE_ID}`, title: 'No' },
    ]);
    for (const b of sent.buttons)
      expect(b.title.length).toBeLessThanOrEqual(20);
  });

  it('takes a document as the receipt directly, notes it, and routes it', async () => {
    h.findOpenOrderForConversation.mockResolvedValue(order);
    h.recordPaymentProof.mockResolvedValue(true);
    const { db, inserts, updates } = makeDb({ handoffAgentId: 'agent-9' });
    await handleInboundPaymentProof({
      db,
      ...base,
      messageId: 'doc-1',
      contentType: 'document',
    });
    expect(h.engineSendInteractiveButtons).not.toHaveBeenCalled();
    expect(h.recordPaymentProof).toHaveBeenCalledWith(
      db,
      'acct-1',
      'o1',
      'doc-1'
    );
    expect(inserts.contact_notes?.[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'c1',
      user_id: 'owner-1',
    });
    expect(updates.conversations?.[0]).toEqual({
      assigned_agent_id: 'agent-9',
    });
    expect(h.engineSendText.mock.calls[0][0].text).toContain('INV-0007');
  });

  it('swallows errors so the webhook is never affected', async () => {
    h.findOpenOrderForConversation.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb({});
    await expect(
      handleInboundPaymentProof({
        db,
        ...base,
        messageId: IMAGE_ID,
        contentType: 'image',
      })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('handleReceiptReply', () => {
  it('attaches the image after a "Yes" tap, verifying it is a customer image here', async () => {
    h.findOpenOrderForConversation.mockResolvedValue(order);
    h.recordPaymentProof.mockResolvedValue(true);
    const { db, filters, inserts } = makeDb({});
    await handleReceiptReply({
      db,
      ...base,
      replyId: `${RECEIPT_YES_PREFIX}${IMAGE_ID}`,
    });
    expect(filters.messages).toEqual(
      expect.arrayContaining([
        ['id', IMAGE_ID],
        ['conversation_id', 'cv1'],
        ['sender_type', 'customer'],
        ['content_type', 'image'],
      ])
    );
    expect(h.recordPaymentProof).toHaveBeenCalledWith(
      db,
      'acct-1',
      'o1',
      IMAGE_ID
    );
    expect(inserts.contact_notes).toHaveLength(1);
    expect(h.engineSendText.mock.calls[0][0].text).toContain('INV-0007');
  });

  it('never reassigns a thread a human already owns', async () => {
    h.findOpenOrderForConversation.mockResolvedValue(order);
    h.recordPaymentProof.mockResolvedValue(true);
    const { db, updates } = makeDb({
      handoffAgentId: 'agent-9',
      assignedAgentId: 'agent-2',
    });
    await handleReceiptReply({
      db,
      ...base,
      replyId: `${RECEIPT_YES_PREFIX}${IMAGE_ID}`,
    });
    expect(updates.conversations).toBeUndefined();
  });

  it('ignores a "Yes" for an image that is not in this conversation', async () => {
    h.findOpenOrderForConversation.mockResolvedValue(order);
    const { db } = makeDb({ imageExists: false });
    await handleReceiptReply({
      db,
      ...base,
      replyId: `${RECEIPT_YES_PREFIX}${IMAGE_ID}`,
    });
    expect(h.recordPaymentProof).not.toHaveBeenCalled();
  });

  it('ignores malformed ids', async () => {
    const { db } = makeDb({});
    await handleReceiptReply({
      db,
      ...base,
      replyId: `${RECEIPT_YES_PREFIX}not-a-uuid`,
    });
    expect(h.recordPaymentProof).not.toHaveBeenCalled();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });

  it('acknowledges a "No" without touching the order', async () => {
    const { db } = makeDb({});
    await handleReceiptReply({
      db,
      ...base,
      replyId: `${RECEIPT_NO_PREFIX}${IMAGE_ID}`,
    });
    expect(h.recordPaymentProof).not.toHaveBeenCalled();
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the order was no longer open', async () => {
    h.findOpenOrderForConversation.mockResolvedValue(order);
    h.recordPaymentProof.mockResolvedValue(false);
    const { db, inserts } = makeDb({});
    await handleReceiptReply({
      db,
      ...base,
      replyId: `${RECEIPT_YES_PREFIX}${IMAGE_ID}`,
    });
    expect(inserts.contact_notes).toBeUndefined();
    expect(h.engineSendText).not.toHaveBeenCalled();
  });
});

describe('isReceiptReply', () => {
  it('matches only this module’s button ids', () => {
    expect(isReceiptReply(`${RECEIPT_YES_PREFIX}${IMAGE_ID}`)).toBe(true);
    expect(isReceiptReply(`${RECEIPT_NO_PREFIX}${IMAGE_ID}`)).toBe(true);
    expect(isReceiptReply('flow_button_1')).toBe(false);
    expect(isReceiptReply(null)).toBe(false);
  });
});
