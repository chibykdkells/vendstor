import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from '../types'
import { aiRequestTimeoutMs } from '../defaults'
import { parseGeneration } from '../generate'
import { resolveOpenAiCompatibleEndpoint } from '../providers/openai-compatible'
import { anthropicAgentStep } from './anthropic'
import { chatCompletionAgentStep } from './openai'
import type {
  AgentMessage,
  AgentStepResult,
  ToolCall,
  ToolDefinition,
  ToolOutcome,
} from './types'

/** Model round trips per customer message before we give up and hand
 *  off. Each tool round is one step; the final reply is one more. */
export const DEFAULT_MAX_AGENT_STEPS = 5

export interface RunAgentArgs {
  config: AiConfig
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  tools: ToolDefinition[]
  executeTool: (call: ToolCall) => Promise<ToolOutcome>
  maxSteps?: number
}

export interface AgentRunResult extends GenerateResult {
  toolCallCount: number
}

/**
 * Tool-calling variant of `generateReply` for the auto-reply bot. Loops:
 * model → (tool calls → results →) model … until it answers in text.
 * Text the model writes alongside tool calls ("let me check…") is
 * dropped — only the final turn is the customer reply — so the
 * customer gets one message, not a running commentary.
 *
 * Returns the same `{ text, handoff, usage }` shape as `generateReply`
 * (usage summed over every round trip). Running out of steps is treated
 * as a handoff. Provider failures throw `AiError`, as in `generateReply`.
 */
export async function runAgent(args: RunAgentArgs): Promise<AgentRunResult> {
  const { config, systemPrompt, tools, executeTool } = args
  const maxSteps = args.maxSteps ?? DEFAULT_MAX_AGENT_STEPS
  const step = await stepFor(config, systemPrompt, tools)

  const transcript: AgentMessage[] = args.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
  let usage: AiUsage | null = null
  let toolCallCount = 0

  for (let i = 0; i < maxSteps; i++) {
    const res = await step(transcript)
    usage = addUsage(usage, res.usage)

    if (res.toolCalls.length === 0) {
      return { ...parseGeneration(res.text, usage), toolCallCount }
    }

    transcript.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls })
    for (const call of res.toolCalls) {
      toolCallCount++
      const outcome = await safeExecute(executeTool, call)
      transcript.push({
        role: 'tool',
        toolCallId: call.id,
        content: outcome.content,
        isError: outcome.isError,
      })
    }
  }

  console.warn(
    `[ai agent] still calling tools after ${maxSteps} steps — handing off.`,
  )
  return { text: '', handoff: true, usage, toolCallCount }
}

type Step = (messages: AgentMessage[]) => Promise<AgentStepResult>

async function stepFor(
  config: AiConfig,
  systemPrompt: string,
  tools: ToolDefinition[],
): Promise<Step> {
  const base = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    tools,
    timeoutMs: aiRequestTimeoutMs(),
  }
  switch (config.provider) {
    case 'anthropic':
      return (messages) => anthropicAgentStep({ ...base, messages })
    case 'openai':
      return (messages) => chatCompletionAgentStep({ ...base, messages })
    case 'openai_compatible': {
      // Resolve + SSRF-check once per run, not per round trip.
      const endpoint = await resolveOpenAiCompatibleEndpoint(config.baseUrl)
      return (messages) =>
        chatCompletionAgentStep({
          ...base,
          messages,
          endpoint,
          providerLabel: 'OpenAI-compatible provider',
          maxTokensField: 'max_tokens',
        })
    }
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }
}

/** A throwing tool becomes an error result the model can react to,
 *  rather than failing the whole reply. */
async function safeExecute(
  executeTool: RunAgentArgs['executeTool'],
  call: ToolCall,
): Promise<ToolOutcome> {
  try {
    return await executeTool(call)
  } catch (err) {
    console.error(`[ai agent] tool ${call.name} failed:`, err)
    return {
      content: JSON.stringify({
        error:
          'The tool failed unexpectedly. Do not retry it; tell the customer a team member will follow up.',
      }),
      isError: true,
    }
  }
}

function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}
