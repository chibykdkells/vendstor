import type { AiUsage } from '../types'

// ============================================================
// Provider-neutral tool-calling types for the auto-reply agent.
//
// The plain reply path (`generateReply`) is text in → text out. The
// agent adds tools: the model may answer with tool calls, we run them,
// feed the results back, and loop until it writes the customer reply.
// Each provider adapter translates these shapes to its wire format.
// ============================================================

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  /** Provider-issued id; echoed back with the result. */
  id: string
  name: string
  /** Parsed arguments. Malformed JSON from the model arrives as
   *  `{ __invalid_json: '<raw>' }` so the executor can report it. */
  input: Record<string, unknown>
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean }

/** One model round trip. `text` may be empty when it only calls tools. */
export interface AgentStepResult {
  text: string
  toolCalls: ToolCall[]
  usage: AiUsage | null
}

export interface AgentStepArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: AgentMessage[]
  tools: ToolDefinition[]
  timeoutMs: number
}

/** What a tool returns to the model. */
export interface ToolOutcome {
  /** Usually JSON; shown to the model verbatim. */
  content: string
  isError?: boolean
}
