import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describe, expect, it, vi } from 'vitest'
import { syncTools, type McpResult } from '../src/tools.ts'

/**
 * Drive the real run_code dispatch bridge while replacing only the code
 * execution substrate. The nested binding must reach the MCP Client adapter,
 * not a hand-written stand-in ToolDefinition.
 */
class ScriptedPtcRuntime extends Service {
  readonly language = 'typescript'
  readonly isolation = 'test'
  readonly programFormat = 'function-body' as const
  readonly executionInstructions = ''

  constructor(ctx: Context) {
    super(ctx, 'ptcRuntime')
  }

  resolve<T extends { cwd?: string; timeoutMs?: number | null }>(request: T) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  async run(request: {
    program: string
    bindings: Array<{ functions: Record<string, (args: unknown) => Promise<JsonValue>> }>
  }) {
    expect(request.program).toContain('tools.mcp__ttsc__inspect_typescript_graph')
    const call = request.bindings[0]!.functions.mcp__ttsc__inspect_typescript_graph
    if (call === undefined) throw new Error('MCP graph tool was not exposed to run_code')
    const reply = await call({ operation: 'lookup' })
    return { logs: [], value: (reply as McpResult).structuredContent }
  }

  release(): Promise<void> {
    return Promise.resolve()
  }
}

describe('MCP structuredContent through PTC run_code', () => {
  it('returns the unmodified structured payload from an MCP sub-dispatch', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime, { mode: 'ptc' })
      await ctx.plugin(ScriptedPtcRuntime)

      const structuredContent = {
        audit: 'Graph evidence',
        next: { action: 'inspect', reason: 'More details required', request: 'details' },
        result: { type: 'lookup', hits: [{ name: 'ExampleService', edges: [{ to: 'Repository' }] }] },
      }
      const client = {
        getServerCapabilities: () => ({ tools: {} }),
        listTools: vi.fn(async () => ({
          tools: [{
            name: 'inspect_typescript_graph',
            inputSchema: { type: 'object', properties: { operation: { type: 'string' } } },
            outputSchema: { type: 'object' },
          }],
        })),
        callTool: vi.fn(async () => ({ content: [], structuredContent })),
      }
      await syncTools(client as never, ctx, {
        serverName: 'ttsc',
        registrationFailure: 'throw',
        toolCallTimeoutMs: 60_000,
      }, new Map())

      const result = await ctx.tools.execute({
        name: RUN_CODE_NAME,
        callId: ToolCallId('ptc-mcp-structured'),
        signal: new AbortController().signal,
        arguments: {
          description: 'Read the TypeScript graph',
          code: 'return (await tools.mcp__ttsc__inspect_typescript_graph({ operation: "lookup" })).structuredContent',
        },
      })

      expect(result.isError).toBe(false)
      if (result.isError) throw new Error(result.error.message)
      expect(result.value).toEqual({ logs: [], result: structuredContent })
      expect(client.callTool).toHaveBeenCalledWith(
        { name: 'inspect_typescript_graph', arguments: { operation: 'lookup' } },
        expect.objectContaining({ timeout: 60_000 }),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
