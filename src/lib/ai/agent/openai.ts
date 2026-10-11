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

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: {
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null
      tool_calls?: {
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Translate the neutral transcript to Chat Completions messages.
 * Consecutive plain user/assistant turns are merged (as the plain
 * adapters do); turns carrying tool calls or results are kept as-is so
 * every `tool` message directly follows the assistant turn that called
 * it.
 */
export function toChatCompletionMessages(
  systemPrompt: string,
  messages: AgentMessage[],
): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
      continue
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: m.content.trim() ? m.content : null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      })
      continue
    }
    const last = out[out.length - 1]
    if (
      last &&
      last.role === m.role &&
      !('tool_calls' in last && last.tool_calls) &&
      typeof last.content === 'string'
    ) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { __invalid_json: raw }
  } catch {
    return { __invalid_json: raw }
  }
}

export interface ChatCompletionStepArgs extends AgentStepArgs {
  /** Full chat-completions URL. Defaults to OpenAI's. */
  endpoint?: string
  /** Label for error messages. */
  providerLabel?: string
  /** OpenAI's newer models take `max_completion_tokens`; generic
   *  OpenAI-compatible servers expect `max_tokens`. */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens'
}

/** One Chat Completions call with tools (OpenAI or a compatible server). */
export async function chatCompletionAgentStep(
  args: ChatCompletionStepArgs,
): Promise<AgentStepResult> {
  const {
    apiKey,
    model,
    systemPrompt,
    messages,
    tools,
    timeoutMs,
    endpoint = OPENAI_URL,
    providerLabel = 'OpenAI',
    maxTokensField = 'max_completion_tokens',
  } = args

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      // A compatible server must not bounce us to another host (the SSRF
      // check only vetted this one) — same as the plain adapter.
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: toChatCompletionMessages(systemPrompt, messages),
        tools: tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        [maxTokensField]: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) throw await providerHttpError(providerLabel, res)

  const data = (await res.json().catch(() => null)) as ChatCompletionResponse | null
  const message = data?.choices?.[0]?.message
  const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
    .filter((c) => typeof c.id === 'string' && typeof c.function?.name === 'string')
    .map((c) => ({
      id: c.id!,
      name: c.function!.name!,
      input: parseArguments(c.function?.arguments),
    }))

  return {
    text: typeof message?.content === 'string' ? message.content.trim() : '',
    toolCalls,
    usage: normalizeUsage({
      prompt: data?.usage?.prompt_tokens,
      completion: data?.usage?.completion_tokens,
      total: data?.usage?.total_tokens,
    }),
  }
}
