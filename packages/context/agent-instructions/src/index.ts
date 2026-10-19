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
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
  type InstructionReconciliation,
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

/**
 * Explain a held-back write whose instruction files could not be confirmed.
 * @param filePath - the held target file.
 * @param paths - display paths of the instruction candidates that could not be settled.
 * @returns the model-facing denial reason.
 */
function preEditUnconfirmedReason(filePath: string, paths: readonly string[]): string {
  const listed = paths.length > 0 ? paths.map(path => `\`${path}\``).join(', ') : 'its workspace instructions'
  return `cannot confirm the workspace instructions that apply to \`${filePath}\`: ${listed} could not be read or encoded. `
    + 'Strict pre-edit protection refuses the modification until they can be read. '
    + 'Report the unreadable instruction state instead of retrying, or ask the operator to restore readability.'
}

/**
 * Name the instruction candidates that govern a filesystem directory.
 * @param directory - absolute directory whose candidates apply.
 * @param resolved - normalized plugin configuration.
 * @returns absolute candidate paths.
 */
function describeProjectInstructionTargets(
  directory: string,
  resolved: ResolvedConfig,
): string[] {
  if (!isAbsolute(directory)) return [directory]
  return [...resolved.instructionFileCandidates, ...resolved.localInstructionFileCandidates]
    .map(candidate => join(directory, candidate))
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  // Registered as one named first-party section rather than folded into the
  // system prompt wholesale, so persona, tool guidance, and per-agent scoped
  // overlays keep their own slots. Injection is reactive: the section appears
  // when the service becomes available and is withdrawn with it, so plugin
  // activation order does not decide whether the protocol reaches the model.
  ctx.inject(['systemPrompt'], (scope: Context) => {
    scope.systemPrompt.section({
      name: WORKSPACE_PROTOCOL_SECTION,
      order: scope.systemPrompt.getSectionOrder('WORKSPACE_INSTRUCTIONS_PROTOCOL'),
      text: WORKSPACE_INSTRUCTIONS_PROTOCOL,
      interpolate: false,
    })
  })
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const baselinePreparations = new WeakMap<Session, {
    identity: string
    excludedScopes: ReadonlySet<string>
  }>()
  const projectionLifecycle = new AbortController()
  type ProjectionTouch = { agent: Agent; path: string }
  const executionTouches = new Map<ToolExecutionToken, ProjectionTouch[]>()
  // Instructions to ferry on a write held back by pre-edit protection, keyed by
  // the refused call's execution token. A deny skips dispatch but still reaches
  // post-execute with that token, so unrelated results never consume the entry.
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
      const incompleteBaseline = new Set(instructions?.rendered.truncated
        .filter(entry => entry.includedBytes < entry.originalBytes)
        .map(entry => entry.displayPath) ?? [])
      const baseline = baselineInstructionState(instructions?.included ?? [], incompleteBaseline)
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
    if (update.context !== undefined) {
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
   * Resolve the scopes a write's target directory adds and confirm whether their
   * instructions reached the model, ferrying any that did not.
   *
   * A confirmed absence and a delivered file both proceed. An unreadable
   * provider, an unreadable instruction file, an uncompiled project scope, or a
   * render budget that dropped the content holds the call: under strict
   * pre-edit protection an unknown instruction state is never treated as
   * "no instructions apply".
   * @returns a denial carrying the pending instructions, or undefined to proceed.
   */
  const inspectWriteInstructions = async (
    exec: ToolExecution,
    agent: Agent,
    filePath: string,
  ): Promise<PreToolDecision | undefined> => {
    const signal = exec.signal
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return undefined
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const targetDir = dirname(resolve(cwd, filePath))
    let reconciliation: InstructionReconciliation
    try {
      const projectRoot = await findProjectRoot(targetDir, resolved.projectRootMarkers, fileSystem, signal)
      // Recheck the target's full applicable chain, including the baseline.
      // Rules from an unrelated working-directory subtree are not applicable.
      reconciliation = await reconcileInstructionContext(
        agent,
        resolved,
        instructionVersions,
        fileSystem,
        {
          cwd: targetDir,
          authorityMessages: [],
          scopeMessages: [],
          touchedPaths: [],
          includeBaselineScopes: true,
          applicableScopesOnly: true,
          projectRoot,
          signal,
        },
      )
    } catch (error: unknown) {
      if (signal.aborted) throw error
      return {
        kind: 'deny',
        reason: preEditUnconfirmedReason(filePath, describeProjectInstructionTargets(dirname(resolve(cwd, filePath)), resolved)),
        info: PRE_EDIT_GUARD_INFO,
      }
    }
    // Only this pass settles a call: baseline scopes are excluded here, so a
    // scope the model holds from history does not settle a file whose prose
    // never entered a context.
    const { context, unconfirmed } = reconciliation
    // The version cache is deliberately not committed here: a ferried context is
    // not durable until the loop enters it, so a lost ferry leaves the call
    // held rather than silently allowing the uninstructed write.
    if (context !== undefined) guardedInstructions.set(exec.token, context)
    if (context === undefined && unconfirmed.length === 0) return undefined
    if (unconfirmed.length === 0) {
      // The pending context carries these files to the next result, so the model
      // receives them before it can repeat the write.
      const delivered = context?.source.kind === 'agent-instructions'
        ? context.source.changes.map(change => change.path)
        : []
      return { kind: 'deny', reason: preEditDenialReason(delivered), info: PRE_EDIT_GUARD_INFO }
    }
    // A scope this pass could not settle: neither a delivery nor history shows
    // the model its instructions, so the call stays held.
    const held = [...new Set(unconfirmed.flatMap(entry => entry.paths))]
    return { kind: 'deny', reason: preEditUnconfirmedReason(filePath, held), info: PRE_EDIT_GUARD_INFO }
  }

  /**
   * Hold back a structured write whose applicable workspace instructions the
   * model has not received yet, and ferry those instructions on the refusal.
   *
   * Only a call whose target path is readable from `arguments` is checked, so
   * an unrecognized tool is never guessed at and arguments are never rewritten.
   * @param exec - pending tool execution.
   * @returns a denial carrying the pending instructions, or undefined to proceed.
   */
  const holdUninstructedWrite = async (exec: ToolExecution): Promise<PreToolDecision | undefined> => {
    if (!resolved.preEditProtection) return undefined
    if (!FILE_WRITE_TOOL_NAMES.has(exec.name)) return undefined
    const agent = exec.agent
    const filePath = filePathFromExecution(exec)
    if (agent === undefined || filePath === undefined) return undefined
    return await inspectWriteInstructions(exec, agent, filePath)
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

  ctx.on('tools/post-execute', async (exec: ToolExecution, _result, next): Promise<PostToolDecision> => {
    const pending = guardedInstructions.get(exec.token)
    if (pending === undefined) return await next()
    guardedInstructions.delete(exec.token)
    // Delegate first so downstream policies still decide this result, then
    // compose: a blocked result keeps its feedback and only gains the context,
    // while an accepted result never loses a content or value replacement.
    const decision = await next()
    return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], pending] }
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
