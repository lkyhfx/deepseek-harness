/**
 * Workspace instruction loader for AGENTS.md-compatible files.
 *
 * Baseline instructions enter durable context before the first request; successful fs
 * tool touches project nested, changed, and removed instructions into the inbox.
 * Plugin lifecycle reads use the optional `ctx.fs` provider, so providerless products
 * mount it as a no-op.
 *
 * @module @deepseek-ai/dsh-agent-instructions
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
  ToolExecutionToken,
} from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig, workspaceBaselineIdentity, type ResolvedConfig } from './config.ts'
import { findProjectRoot, loadBaselineInstructionSet } from './files.ts'
import { trimmedInstructionDigest } from './digest.ts'
import {
  applyInstructionVersionUpdates,
  baselineInstructionState,
  name,
  reconcileInstructionContext,
  agentInstructionsMessage,
  type InstructionVersionCache,
  type AgentInstructionSource,
  type ReconciledInstructionContext,
} from './state.ts'
import { instructionCandidateGroup, instructionScopeKey, scopeForDisplayPath, type AgentInstructionChange } from './render.ts'
import { WORKSPACE_INSTRUCTIONS_PROTOCOL, WORKSPACE_PROTOCOL_SECTION } from './protocol.ts'

export { Config, name }
/** Services required by workspace instruction projection. */
export const inject = ['sessionProjections', 'workingDirectory']
export {
  discoverBaselineInstructionFiles,
  loadBaselineInstructions,
} from './files.ts'
export type {
  InstructionFile,
  LoadedInstructionFile,
} from './files.ts'
export { renderAgentInstructions } from './render.ts'
export type { RenderedAgentInstructions, TruncatedInstruction } from './render.ts'
export { WORKSPACE_INSTRUCTIONS_PROTOCOL, WORKSPACE_PROTOCOL_SECTION } from './protocol.ts'

function visibleBaselineSource(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): AgentInstructionSource | undefined {
  for (const message of authorityMessages.toReversed()) {
    if (message.source.kind === 'agent-instructions' && message.source.baseline === true) {
      return message.source
    }
  }
  for (const seq of agent.session.surface.nodes.toReversed()) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(seq)
    if (event?.type === 'user/message'
      && event.data.source.kind === 'agent-instructions'
      && event.data.source.baseline === true) return event.data.source
  }
  return undefined
}

function isAgentInstructionsMessage(message: UserMessage): boolean {
  return message.source.kind === 'agent-instructions'
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

/**
 * Structured tools whose call modifies a file's content. Only these are held
 * back before execution; `read` cannot write, so it stays discovery-only.
 */
const FILE_WRITE_TOOL_NAMES = new Set(['write', 'edit'])

function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const filePath = exec.arguments.file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

/**
 * Denial identity for a write held back by pre-edit protection. Carried as
 * {@link ToolErrorInfo} so operators and tests can distinguish this outcome
 * from a permission denial or a schema failure.
 */
const PRE_EDIT_GUARD_INFO = { name: 'WorkspaceInstructionPreEditGuard', code: 'WORKSPACE_INSTRUCTIONS_NOT_LOADED' }

/**
 * Explain a held-back write so the model can act on the refusal instead of
 * retrying the same call. The applicable instruction files are injected
 * separately, as a user-role message, on the next step.
 * @param paths - display paths of instruction files not yet loaded.
 * @returns the model-facing denial reason.
 */
function preEditDenialReason(paths: readonly string[]): string {
  const listed = paths.map(path => `\`${path}\``).join(', ')
  return `workspace instructions must be loaded before modifying this file: ${listed}. `
    + 'They are injected as the next message. Read them and repeat this modification, adjusting it to satisfy those instructions.'
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  // Registered as one named first-party section rather than folded into the
  // system prompt wholesale, so persona, tool guidance, and per-agent scoped
  // overrides keep their own slots. The optional read keeps a providerless
  // composition loading without the section.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: WORKSPACE_PROTOCOL_SECTION,
      order: systemPrompt.getSectionOrder('WORKSPACE_INSTRUCTIONS_PROTOCOL'),
      text: WORKSPACE_INSTRUCTIONS_PROTOCOL,
      interpolate: false,
    })
  }
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const baselinePreparations = new WeakMap<Session, {
    identity: string
    excludedScopes: ReadonlySet<string>
  }>()
  const projectionLifecycle = new AbortController()
  type ProjectionTouch = { agent: Agent; path: string }
  const executionTouches = new Map<ToolExecutionToken, ProjectionTouch[]>()
  // Pending instructions for a write held back by pre-edit protection, keyed by
  // the refused call's execution token. Entry lifetime is one execution.
  const guardedInstructions = new Map<ToolExecutionToken, UserMessage>()
  ctx.effect(
    () => () => {
      projectionLifecycle.abort(new Error('agent-instructions disposed'))
      executionTouches.clear()
      guardedInstructions.clear()
    },
    'agent-instructions.projectionLifecycle',
  )
  // Emit listeners are not awaited, so each projection must compose against the
  // inbox produced by earlier file results for the same agent.
  const projectionTails = new WeakMap<Agent, Promise<void>>()
  // Execution ancestry and the enclosing durable step are the two commit
  // boundaries before an asynchronous projection may mutate the agent inbox.
  const stepTouches = new WeakMap<Session, ProjectionTouch[]>()

  const compose = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    pending: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<UserMessage | undefined> => {
    signal.throwIfAborted()
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
      return undefined
    }
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return undefined
    const content: UserMessage['content'][number][] = []
    const changes: AgentInstructionChange[] = []
    let desiredBaseline = false
    const authorityMessages = [...claimed]
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal)
    const identity = workspaceBaselineIdentity(resolved, cwd, projectRoot)
    if (touchedPaths.length === 0 && pending.length > 0
      && baselinePreparations.get(agent.session)?.identity === identity) return pending[0]
    const visibleBaseline = visibleBaselineSource(agent, authorityMessages)
    const baselinePresent = visibleBaseline !== undefined
    const keepVisibleBaseline = visibleBaseline?.baselineIdentity === identity
    const prepared = baselinePreparations.get(agent.session)
    let excludedBaselineScopes = keepVisibleBaseline && prepared?.identity === identity
      ? prepared.excludedScopes
      : undefined
    let nextPreparation: { identity: string; excludedScopes: ReadonlySet<string> } | undefined
    if (!baselinePresent || !keepVisibleBaseline || excludedBaselineScopes === undefined) {
      const replacePreviousBaseline = baselinePresent && !keepVisibleBaseline
      const instructions = await loadBaselineInstructionSet({
        cwd,
        dshHome: resolved.dshHome,
        agentsHome: resolved.agentsHome,
        projectRootMarkers: resolved.projectRootMarkers,
        maxBytes: resolved.maxBytes,
        maxSourceBytes: resolved.maxSourceBytes,
        instructionFileCandidates: resolved.instructionFileCandidates,
        localInstructionFileCandidates: resolved.localInstructionFileCandidates,
        projectRoot,
        replacePreviousBaseline,
        signal,
      }, fileSystem)
      const baseline = baselineInstructionState(instructions?.included ?? [])
      const observedBaseline = baselineInstructionState(instructions?.observed ?? [])
      const includedDigestsByGroup = new Map<string, Set<string>>()
      for (const file of instructions?.included ?? []) {
        const group = instructionCandidateGroup(scopeForDisplayPath(file.displayPath))
        const digests = includedDigestsByGroup.get(group) ?? new Set<string>()
        digests.add(trimmedInstructionDigest(file.content))
        includedDigestsByGroup.set(group, digests)
      }
      // A duplicate inherits its winner's budget omission. Only duplicates of
      // represented content remain eligible for promotion during reconciliation.
      const excludedScopes = new Set(observedBaseline.changes.keys())
      for (const scope of baseline.changes.keys()) excludedScopes.delete(scope)
      for (const file of instructions?.deduped ?? []) {
        const group = instructionCandidateGroup(scopeForDisplayPath(file.displayPath))
        if (includedDigestsByGroup.get(group)?.has(trimmedInstructionDigest(file.content))) {
          excludedScopes.delete(instructionScopeKey(file.displayPath))
        }
      }
      excludedBaselineScopes = excludedScopes
      nextPreparation = { identity, excludedScopes }
      let versionStates = instructionVersions.get(agent.session)
      if (versionStates === undefined && baseline.versions.size > 0) {
        versionStates = new Map()
        instructionVersions.set(agent.session, versionStates)
      }
      for (const [scope, state] of baseline.versions) versionStates?.set(scope, state)
      if (!keepVisibleBaseline && instructions !== undefined && instructions.rendered.text.length > 0) {
        const baselineContent = agentInstructionsMessage(instructions.rendered.text).content
        content.push(...baselineContent)
        const replacementScopes = new Set(baseline.changes.keys())
        const replacementRemovals = replacePreviousBaseline
          ? visibleBaseline.changes.flatMap(change => (
            change.action === 'remove' || replacementScopes.has(change.scope)
              ? []
              : [{ action: 'remove' as const, scope: change.scope, path: change.path }]
          ))
          : []
        const baselineChanges = [...replacementRemovals, ...baseline.changes.values()]
        changes.push(...baselineChanges)
        authorityMessages.push(createUserMessage({
          content: baselineContent,
          source: {
            kind: 'agent-instructions',
            form: 'instructions',
            baseline: true,
            baselineIdentity: identity,
            changes: baselineChanges,
          },
        }))
        desiredBaseline = true
      }
    }
    const update = await reconcileInstructionContext(
      agent,
      resolved,
      instructionVersions,
      fileSystem,
      {
        cwd,
        authorityMessages,
        scopeMessages: pending,
        includeBaselineScopes: keepVisibleBaseline,
        ...keepVisibleBaseline ? { excludedBaselineScopes } : {},
        touchedPaths,
        projectRoot,
        signal,
      },
    )
    if (update !== undefined) {
      content.push(...update.context.content)
      /* v8 ignore next -- reconciliation constructs only agent-instructions contexts. */
      if (update.context.source.kind === 'agent-instructions') {
        changes.push(...update.context.source.changes)
      }
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, instructionVersions)
    }
    if (nextPreparation !== undefined) baselinePreparations.set(agent.session, nextPreparation)
    if (content.length === 0) return undefined
    return createUserMessage({
      content,
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        ...desiredBaseline ? { baseline: true } : {},
        ...desiredBaseline ? { baselineIdentity: identity } : {},
        changes,
      },
    })
  }

  const syncInbox = (agent: Agent, claimed: readonly UserMessage[], desired: UserMessage | undefined): void => {
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const alreadySupplied = desired !== undefined && (
      claimed.some(message => sameContextPayload(message, desired))
      || agent.session.surface.nodes.some((seq) => {
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        const event = agent.session.eventAt(seq)
        return event?.type === 'user/message' && sameContextPayload(event.data, desired)
      })
    )
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove(message.id)
      return
    }
    const reusable = pending.find(message => sameContextPayload(message, desired))
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove(message.id)
      }
      return
    }
    const replaced = pending[0]
    if (replaced === undefined) agent.inbox.prepend('next-step', desired)
    else agent.inbox.replace(replaced.id, desired)
    for (const message of pending.slice(1)) agent.inbox.remove(message.id)
  }

  const composeAndSync = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<void> => {
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const desired = await compose(agent, signal, claimed, pending, touchedPaths)
    signal.throwIfAborted()
    syncInbox(agent, claimed, desired)
  }

  const queueProjection = (
    agent: Agent,
    touchedPath: string,
  ): void => {
    const previous = projectionTails.get(agent) ?? Promise.resolve()
    const current = previous.then(() => composeAndSync(agent, projectionLifecycle.signal, [], [touchedPath]))
      .catch((error: unknown) => {
        if (!projectionLifecycle.signal.aborted) ctx.logger.warn('workspace instruction refresh failed: %o', error)
      })
    projectionTails.set(agent, current)
    void current.then(() => {
      if (projectionTails.get(agent) === current) projectionTails.delete(agent)
    })
  }

  const waitForProjections = async (agent: Agent): Promise<void> => {
    let projection: Promise<void> | undefined
    while ((projection = projectionTails.get(agent)) !== undefined) await projection
  }

  /**
   * Refuse a structured write whose applicable workspace instructions the model
   * has not received yet, and ferry those instructions on the refusal.
   *
   * Only a call whose target path is readable from `arguments` is checked, so
   * an unrecognized tool is never guessed at and arguments are never rewritten.
   * Unavailable instruction state never refuses a call: a provider failure or
   * an unknown project root must not strand a write the model may perform.
   * @param exec - pending tool execution.
   * @returns a denial carrying the pending instructions, or undefined to proceed.
   */
  const holdUninstructedWrite = async (exec: ToolExecution): Promise<PreToolDecision | undefined> => {
    if (!resolved.preEditProtection) return undefined
    if (!FILE_WRITE_TOOL_NAMES.has(exec.name)) return undefined
    const agent = exec.agent
    const filePath = filePathFromExecution(exec)
    if (agent === undefined || filePath === undefined) return undefined
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return undefined
    const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
    let projectRoot: string
    let pendingInstructions: ReconciledInstructionContext | undefined
    try {
      projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, exec.signal)
      // The baseline chain is loaded before the first request, so only the
      // nested scopes this write's directory adds can still be missing.
      pendingInstructions = await reconcileInstructionContext(
        agent,
        resolved,
        instructionVersions,
        fileSystem,
        {
          cwd,
          authorityMessages: [],
          scopeMessages: [],
          touchedPaths: [filePath],
          includeBaselineScopes: false,
          projectRoot,
          signal: exec.signal,
        },
      )
    } catch (error: unknown) {
      if (exec.signal.aborted) throw error
      return undefined
    }
    if (pendingInstructions === undefined) return undefined
    // The version cache is deliberately not committed here: the pending
    // context is not durable until the loop enters it, so a lost ferry leaves
    // the call held rather than silently allowing the uninstructed write.
    guardedInstructions.set(exec.token, pendingInstructions.context)
    const paths = pendingInstructions.context.source.kind === 'agent-instructions'
      ? pendingInstructions.context.source.changes.map(change => change.path)
      : []
    return { kind: 'deny', reason: preEditDenialReason(paths), info: PRE_EDIT_GUARD_INFO }
  }

  const stepIsOpen = (session: Session): boolean => {
    const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (boundary === undefined) {
      throw new Error('agent-instructions requires the turnBoundary session projection')
    }
    return boundary.openTurnStartSeq !== null
      && boundary.lastStepBoundary?.kind === 'start'
      && boundary.lastStepBoundary.seq > boundary.openTurnStartSeq
  }

  const projectTouch = (touch: ProjectionTouch): void => {
    const session = touch.agent.session
    if (!stepIsOpen(session)) {
      queueProjection(touch.agent, touch.path)
      return
    }
    const pending = stepTouches.get(session)
    if (pending === undefined) stepTouches.set(session, [touch])
    else pending.push(touch)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/end') return
    const pending = stepTouches.get(session)
    if (pending === undefined) return
    stepTouches.delete(session)
    for (const touch of pending) queueProjection(touch.agent, touch.path)
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    await waitForProjections(agent)
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const desired = await compose(agent, signal, messages, pending)
    signal.throwIfAborted()
    // An empty first entry owns a no-step turn; keep context pending instead
    // of turning it into a standalone request. Later entries may be tool continuations.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
      syncInbox(agent, messages, desired)
      return decision
    }
    // A proceeding step settles the pending context: it either enters below as
    // `desired`, or its payload is already covered by the batch, so nothing stays pending.
    for (const message of pending) agent.inbox.remove(message.id)
    if (desired === undefined || decision.messages.some(message => sameContextPayload(message, desired))) {
      return decision
    }
    // Fold the context right after the claimed batch, so the direct prompt
    // precedes it and the driver-appended runtime context follows it.
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { ...decision, messages: entered }
  })

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const decision = await next()
    // A downstream denial already refuses the call; adding a second reason
    // would only replace the operator-visible cause.
    if (decision.kind !== 'allow') return decision
    // Async because it probes instruction files; the registry rechecks
    // cancellation after it settles, so an aborted call never waits on I/O.
    return await holdUninstructedWrite(exec) ?? { kind: 'allow' }
  })

  ctx.on('tools/post-execute', (exec: ToolExecution, _result, next): Promise<PostToolDecision> => {
    const pending = guardedInstructions.get(exec.token)
    if (pending === undefined) return next()
    guardedInstructions.delete(exec.token)
    return Promise.resolve({ kind: 'accept', additionalContexts: [pending] })
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    const touches = executionTouches.get(exec.token) ?? []
    executionTouches.delete(exec.token)
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const ownPath = filePathFromExecution(exec)
      if (ownPath !== undefined) touches.push({ agent: exec.agent, path: ownPath })
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parentTouches = executionTouches.get(exec.parent)
        if (parentTouches === undefined) executionTouches.set(exec.parent, touches)
        else parentTouches.push(...touches)
      }
      return
    }
    for (const touch of touches) projectTouch(touch)
  })
}
