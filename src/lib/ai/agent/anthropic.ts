import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  normalizeUsage,
  providerHttpError,
  toNetworkError,
} from '../providers/shared'
import type {
  AgentMessage,
  AgentStepArgs,
  AgentStepResult,
  ToolCall,
} from './types'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface WireMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

interface AnthropicResponse {
  content?: {
    type?: string
    text?: string
    id?: string
    name?: string
    input?: unknown
  }[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Translate the neutral transcript to Anthropic messages: assistant tool
 * calls become `tool_use` blocks, tool results become `tool_result`
 * blocks in a user turn. Then enforce Anthropic's rules (same as the
 * plain adapter): roles strictly alternate — consecutive same-role turns
 * are merged — and the transcript starts on the customer.
 */
export function toAnthropicMessages(messages: AgentMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  for (const m of messages) {
    let wire: WireMessage
    if (m.role === 'user') {
      wire = { role: 'user', content: [{ type: 'text', text: m.content }] }
    } else if (m.role === 'assistant') {
      const blocks: Block[] = []
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content })
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      }
      if (blocks.length === 0) continue
      wire = { role: 'assistant', content: blocks }
    } else {
      wire = {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
            ...(m.isError ? { is_error: true } : {}),
          },
        ],
      }
    }
    const last = out[out.length - 1]
    if (last && last.role === wire.role) last.content.push(...wire.content)
    else out.push(wire)
  }
  while (out.length > 0 && out[0].role === 'assistant') out.shift()
  if (out.length === 0) {
    out.push({
      role: 'user',
      content: [{ type: 'text', text: '(The customer has not sent a message yet.)' }],
    })
  }
  return out
}

/** One Anthropic Messages call with tools. */
export async function anthropicAgentStep(args: AgentStepArgs): Promise<AgentStepResult> {
  const { apiKey, model, systemPrompt, messages, tools, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: toAnthropicMessages(messages),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) throw await providerHttpError('Anthropic', res)

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const blocks = data?.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
    .map((b) => ({
      id: b.id!,
      name: b.name!,
      input:
        b.input && typeof b.input === 'object' && !Array.isArray(b.input)
          ? (b.input as Record<string, unknown>)
          : {},
    }))

  return {
    text,
    toolCalls,
    usage: normalizeUsage({
      prompt: data?.usage?.input_tokens,
      completion: data?.usage?.output_tokens,
    }),
  }
}
