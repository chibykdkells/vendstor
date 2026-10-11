import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiConfig } from '../types'
import { HANDOFF_SENTINEL } from '../defaults'

const h = vi.hoisted(() => ({
  resolveEndpoint: vi.fn(),
}))
vi.mock('../providers/openai-compatible', () => ({
  resolveOpenAiCompatibleEndpoint: h.resolveEndpoint,
}))

import { runAgent } from './loop'
import type { ToolDefinition } from './types'

const tools: ToolDefinition[] = [
  {
    name: 'search_products',
    description: 'Search the catalog',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
]

function config(provider: AiConfig['provider']): AiConfig {
  return {
    provider,
    model: 'm',
    baseUrl: provider === 'openai_compatible' ? 'https://llm.example.com/v1' : null,
    apiKey: 'k',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 10,
    handoffAgentId: null,
    embeddingsApiKey: null,
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>
const requestBody = (i: number) =>
  JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runAgent — Anthropic', () => {
  it('runs a tool round, feeds the result back, and returns the final text', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'tu_1', name: 'search_products', input: { query: 'shoes' } },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      )
      .mockResolvedValueOnce(
        json({
          content: [{ type: 'text', text: 'We have Ankara Shoes for ₦5,000.' }],
          usage: { input_tokens: 150, output_tokens: 20 },
        }),
      )
    const executeTool = vi.fn().mockResolvedValue({ content: '{"products":[]}' })

    const out = await runAgent({
      config: config('anthropic'),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Do you sell shoes?' }],
      tools,
      executeTool,
    })

    expect(out).toEqual({
      text: 'We have Ankara Shoes for ₦5,000.',
      handoff: false,
      usage: { promptTokens: 250, completionTokens: 30, totalTokens: 280 },
      toolCallCount: 1,
    })
    expect(executeTool).toHaveBeenCalledWith({
      id: 'tu_1',
      name: 'search_products',
      input: { query: 'shoes' },
    })
    const first = requestBody(0)
    expect(first.tools[0]).toMatchObject({ name: 'search_products', input_schema: { type: 'object' } })
    const second = requestBody(1)
    expect(second.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Do you sell shoes?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu_1', name: 'search_products', input: { query: 'shoes' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"products":[]}' }],
      },
    ])
  })

  it('treats the handoff sentinel as a handoff', async () => {
    fetchMock.mockResolvedValueOnce(json({ content: [{ type: 'text', text: HANDOFF_SENTINEL }] }))
    const out = await runAgent({
      config: config('anthropic'),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want a manager' }],
      tools,
      executeTool: vi.fn(),
    })
    expect(out.handoff).toBe(true)
    expect(out.text).toBe('')
  })
})

describe('runAgent — OpenAI chat completions', () => {
  it('sends tool calls and tool results in OpenAI wire format', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'search_products', arguments: '{"query":"bag"}' },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'Yes, ₦1,500!' } }] }))
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' })

    const out = await runAgent({
      config: config('openai'),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'bag?' }],
      tools,
      executeTool,
    })

    expect(out.text).toBe('Yes, ₦1,500!')
    expect(executeTool).toHaveBeenCalledWith({
      id: 'call_1',
      name: 'search_products',
      input: { query: 'bag' },
    })
    const first = requestBody(0)
    expect(first.max_completion_tokens).toBeDefined()
    expect(first.tools[0]).toMatchObject({ type: 'function', function: { name: 'search_products' } })
    expect(requestBody(1).messages.slice(1)).toEqual([
      { role: 'user', content: 'bag?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search_products', arguments: '{"query":"bag"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ])
  })

  it('passes malformed tool arguments through as __invalid_json', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          choices: [
            {
              message: {
                tool_calls: [
                  { id: 'c', function: { name: 'search_products', arguments: '{not json' } },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'done' } }] }))
    const executeTool = vi.fn().mockResolvedValue({ content: 'x' })
    await runAgent({
      config: config('openai'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools,
      executeTool,
    })
    expect(executeTool.mock.calls[0][0].input).toEqual({ __invalid_json: '{not json' })
  })

  it('uses the SSRF-checked endpoint and max_tokens for OpenAI-compatible providers', async () => {
    h.resolveEndpoint.mockResolvedValue('https://llm.example.com/v1/chat/completions')
    fetchMock.mockResolvedValueOnce(json({ choices: [{ message: { content: 'hi' } }] }))
    await runAgent({
      config: config('openai_compatible'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools,
      executeTool: vi.fn(),
    })
    expect(h.resolveEndpoint).toHaveBeenCalledWith('https://llm.example.com/v1')
    expect(fetchMock.mock.calls[0][0]).toBe('https://llm.example.com/v1/chat/completions')
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
    expect(requestBody(0).max_tokens).toBeDefined()
  })
})

describe('runAgent — safety rails', () => {
  const toolCallResponse = () =>
    json({ content: [{ type: 'tool_use', id: 'tu', name: 'search_products', input: {} }] })

  it('hands off when the model keeps calling tools past the step limit', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(toolCallResponse()))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await runAgent({
      config: config('anthropic'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools,
      executeTool: vi.fn().mockResolvedValue({ content: 'x' }),
      maxSteps: 3,
    })
    expect(out).toMatchObject({ text: '', handoff: true, toolCallCount: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('turns a throwing tool into an error result instead of failing the reply', async () => {
    fetchMock
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'Someone will follow up.' }] }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await runAgent({
      config: config('anthropic'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools,
      executeTool: vi.fn().mockRejectedValue(new Error('db down')),
    })
    expect(out.text).toBe('Someone will follow up.')
    const toolResult = requestBody(1).messages[2].content[0]
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'tu', is_error: true })
  })
})
