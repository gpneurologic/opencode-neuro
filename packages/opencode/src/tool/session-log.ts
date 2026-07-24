import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Tool from "./tool"
import DESCRIPTION from "./session-log.txt"
import { Session } from "../session/session"
import { Provider } from "../provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const num = new Intl.NumberFormat("en-US")

export const Parameters = Schema.Struct({
  filename: Schema.String.annotate({
    description:
      "The absolute path to the file to write the session log to. Relative paths resolve against the current working directory.",
  }),
  format: Schema.Literals(["markdown", "json"])
    .annotate({
      description: "Output format for the log file: 'markdown' (default) or 'json'.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
})

type Metadata = {
  filepath: string
  bytes: number
  messageCount: number
  format: "markdown" | "json"
}

// --- helpers -----------------------------------------------------------------

type AssistantLike = Extract<SessionV1.Info, { role: "assistant" }>

function lastProducingAssistant(messages: readonly SessionV1.WithParts[]): AssistantLike | undefined {
  // Mirror the sidebar (and `usage` tool): the per-turn context figure is the
  // most recent assistant message that actually produced output.
  let result: AssistantLike | undefined
  for (const m of messages) {
    if (m.info.role === "assistant" && m.info.tokens.output > 0) result = m.info
  }
  return result
}

function turnTokens(info: AssistantLike): {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
} {
  const cacheRead = info.tokens.cache.read
  const cacheWrite = info.tokens.cache.write
  const total = info.tokens.input + info.tokens.output + info.tokens.reasoning + cacheRead + cacheWrite
  return {
    input: info.tokens.input,
    output: info.tokens.output,
    reasoning: info.tokens.reasoning,
    cacheRead,
    cacheWrite,
    total,
  }
}

function aggregateTokens(messages: readonly SessionV1.WithParts[]) {
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const m of messages) {
    if (m.info.role !== "assistant") continue
    input += m.info.tokens.input
    output += m.info.tokens.output
    reasoning += m.info.tokens.reasoning
    cacheRead += m.info.tokens.cache.read
    cacheWrite += m.info.tokens.cache.write
  }
  return {
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  }
}

function aggregateCost(messages: readonly SessionV1.WithParts[]): number {
  let cost = 0
  for (const m of messages) {
    if (m.info.role === "assistant") cost += m.info.cost
  }
  return cost
}

function uniqueModels(messages: readonly SessionV1.WithParts[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const m of messages) {
    if (m.info.role !== "assistant") continue
    const id = `${m.info.providerID}/${m.info.modelID}`
    if (!seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

function formatTimestamp(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "(unknown)"
  return new Date(ms).toISOString()
}

function trim(text: string, max = 8000): string {
  if (text.length <= max) return text
  const omitted = text.length - max
  return `${text.slice(0, max)}\n\n[... truncated ${num.format(omitted)} chars ...]`
}

function summarizePart(part: SessionV1.Part): string {
  switch (part.type) {
    case "text":
      return part.text
    case "reasoning":
      return part.text
    case "file":
      return `[file: ${part.mime}${part.filename ? ` — ${part.filename}` : ""}]`
    case "agent":
      return `[agent: ${part.name}]`
    case "compaction":
      return `[compaction${part.overflow ? " (overflow)" : ""}]`
    case "subtask":
      return `[subtask → ${part.agent}: ${part.description}]`
    case "retry":
      return `[retry attempt ${part.attempt}]`
    case "step-start":
      return "[step-start]"
    case "step-finish":
      return `[step-finish: ${part.reason}]`
    case "snapshot":
      return `[snapshot: ${part.snapshot.slice(0, 12)}...]`
    case "patch":
      return `[patch: ${part.files.length} file(s)]`
    default:
      return ""
  }
}

function renderToolPart(part: Extract<SessionV1.Part, { type: "tool" }>): string {
  const lines: string[] = []
  lines.push(`### Tool — \`${part.tool}\``)
  lines.push(`- **callID**: ${part.callID}`)
  const input = JSON.stringify(part.state.input, null, 2)
  lines.push(`- **input**:`)
  lines.push("```json")
  lines.push(trim(input, 4000))
  lines.push("```")
  switch (part.state.status) {
    case "pending":
      lines.push(`- **status**: pending`)
      break
    case "running":
      lines.push(`- **status**: running (started ${formatTimestamp(part.state.time.start)})`)
      break
    case "completed":
      lines.push(`- **status**: completed`)
      lines.push(`- **title**: ${part.state.title}`)
      lines.push(`- **duration**: ${part.state.time.end - part.state.time.start} ms`)
      lines.push(`- **output**:`)
      lines.push("```")
      lines.push(trim(part.state.output, 8000))
      lines.push("```")
      if (part.state.attachments?.length) {
        lines.push(`- **attachments**: ${part.state.attachments.length} file(s)`)
        for (const a of part.state.attachments) {
          lines.push(`  - ${a.mime}${a.filename ? ` — ${a.filename}` : ""}`)
        }
      }
      break
    case "error":
      lines.push(`- **status**: error`)
      lines.push(`- **error**:`)
      lines.push("```")
      lines.push(trim(part.state.error, 4000))
      lines.push("```")
      break
  }
  return lines.join("\n")
}

function renderMessageMarkdown(message: SessionV1.WithParts, index: number): string {
  const lines: string[] = []
  const info = message.info
  lines.push(`### ${index + 1}. ${info.role} — \`${info.id}\``)
  if (info.role === "user") {
    lines.push(`- **agent**: ${info.agent}`)
    lines.push(`- **created**: ${formatTimestamp(info.time.created)}`)
    if (info.summary?.title) lines.push(`- **summary**: ${info.summary.title}`)
  } else {
    lines.push(`- **model**: ${info.providerID}/${info.modelID}`)
    lines.push(`- **agent**: ${info.agent}`)
    lines.push(`- **created**: ${formatTimestamp(info.time.created)}`)
    if (info.time.completed) lines.push(`- **completed**: ${formatTimestamp(info.time.completed)}`)
    const t = turnTokens(info)
    lines.push(
      `- **tokens**: ${num.format(t.total)} (input: ${num.format(t.input)}, output: ${num.format(t.output)}, reasoning: ${num.format(t.reasoning)}, cache read: ${num.format(t.cacheRead)}, cache write: ${num.format(t.cacheWrite)})`,
    )
    lines.push(`- **cost**: ${money.format(info.cost)}`)
    if (info.finish) lines.push(`- **finish**: ${info.finish}`)
    if (info.error) lines.push(`- **error**: ${info.error.name}`)
  }
  if (message.parts.length === 0) {
    lines.push("")
    lines.push("_(no parts)_")
    return lines.join("\n")
  }
  lines.push("")
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.trim().length === 0) continue
      lines.push(trim(part.text, 16000))
      lines.push("")
    } else if (part.type === "reasoning") {
      if (part.text.trim().length === 0) continue
      lines.push("> **Reasoning:**")
      lines.push("> " + trim(part.text, 8000).replace(/\n/g, "\n> "))
      lines.push("")
    } else if (part.type === "tool") {
      lines.push(renderToolPart(part))
      lines.push("")
    } else {
      const summary = summarizePart(part)
      if (summary) {
        lines.push(summary)
        lines.push("")
      }
    }
  }
  return lines.join("\n")
}

function buildMarkdown(input: {
  session: Session.Info
  messages: SessionV1.WithParts[]
  modelName: string | null
  contextLimit: number | null
  contextTokens: number
  sessionCost: number
}): string {
  const { session, messages, modelName, contextLimit, contextTokens } = input
  const aggregate = aggregateTokens(messages)
  const models = uniqueModels(messages)
  const sessionTokens = session.tokens ?? aggregate
  const totalTokens =
    sessionTokens.input + sessionTokens.output + sessionTokens.reasoning + sessionTokens.cache.read + sessionTokens.cache.write
  const percent = contextLimit && contextLimit > 0 ? Math.round((contextTokens / contextLimit) * 100) : null

  const lines: string[] = []
  lines.push(`# Session Log — \`${session.id}\``)
  lines.push("")
  lines.push(`**Title**: ${session.title || "(untitled)"}`)
  lines.push(`**Created**: ${formatTimestamp(session.time.created)}`)
  lines.push(`**Updated**: ${formatTimestamp(session.time.updated)}`)
  if (session.parentID) lines.push(`**Parent session**: ${session.parentID}`)
  lines.push("")
  lines.push(`## Stats`)
  lines.push("")
  const primaryModel = modelName ?? (models[0] ?? (session.model ? `${session.model.providerID}/${session.model.id}` : "(unknown)"))
  lines.push(`- **Model**: ${primaryModel}`)
  if (models.length > 1) {
    lines.push(`- **Models used in this session**: ${models.join(", ")}`)
  }
  lines.push(
    `- **Tokens spent**: ${num.format(totalTokens)} (input: ${num.format(sessionTokens.input)}, output: ${num.format(sessionTokens.output)}, reasoning: ${num.format(sessionTokens.reasoning)}, cache read: ${num.format(sessionTokens.cache.read)}, cache write: ${num.format(sessionTokens.cache.write)})`,
  )
  if (contextLimit) {
    lines.push(
      `- **Context used**: ${num.format(contextTokens)} / ${num.format(contextLimit)} tokens${percent !== null ? ` (${percent}%)` : ""}`,
    )
  } else {
    lines.push(`- **Context used**: ${num.format(contextTokens)} tokens (limit unknown)`)
  }
  lines.push(`- **Cost**: ${money.format(input.sessionCost)} spent this session`)
  lines.push("")
  lines.push("---")
  lines.push("")
  lines.push(`## Message History (${messages.length} message${messages.length === 1 ? "" : "s"})`)
  lines.push("")
  if (messages.length === 0) {
    lines.push("_(no messages yet)_")
  } else {
    messages.forEach((m, i) => {
      lines.push(renderMessageMarkdown(m, i))
    })
  }
  lines.push("")
  return lines.join("\n")
}

// --- tool --------------------------------------------------------------------

export const SessionLogTool = Tool.define<typeof Parameters, Metadata, Session.Service | Provider.Service | FSUtil.Service>(
  "session_log",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: { filename: string; format: "markdown" | "json" },
        ctx: Tool.Context<Metadata>,
      ) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filename)
            ? params.filename
            : path.join(instance.directory, params.filename)

          yield* assertExternalDirectoryEffect(ctx, filepath)

          const session = yield* sessions.get(ctx.sessionID)
          const messages = ctx.messages?.length ? ctx.messages : yield* sessions.messages({ sessionID: ctx.sessionID })

          const last = lastProducingAssistant(messages)
          let modelName: string | null = null
          let contextLimit: number | null = null
          let contextTokens = 0
          if (last) {
            const model = yield* provider
              .getModel(ProviderV2.ID.make(last.providerID), ModelV2.ID.make(last.modelID))
              .pipe(
                Effect.map((m) => ({ name: m.name, context: m.limit.context || null })),
                Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed({ name: null, context: null })),
              )
            modelName = model.name
            contextLimit = model.context
            contextTokens = turnTokens(last).total
          }

          const sessionCost = session.cost ?? aggregateCost(messages)

          const body =
            params.format === "json"
              ? JSON.stringify(
                  {
                    session: {
                      id: session.id,
                      title: session.title,
                      parentID: session.parentID,
                      directory: session.directory,
                      createdAt: session.time.created,
                      updatedAt: session.time.updated,
                      model: session.model,
                      cost: sessionCost,
                      tokens: session.tokens ?? aggregateTokens(messages),
                    },
                    stats: {
                      modelName,
                      models: uniqueModels(messages),
                      contextTokens,
                      contextLimit,
                      contextPercent: contextLimit && contextLimit > 0 ? (contextTokens / contextLimit) * 100 : null,
                    },
                    messages,
                  },
                  null,
                  2,
                )
              : buildMarkdown({
                  session,
                  messages,
                  modelName,
                  contextLimit,
                  contextTokens,
                  sessionCost,
                })

          yield* fs.writeWithDirs(filepath, body)
          return {
            title: path.relative(instance.worktree, filepath),
            output: `Wrote session log to ${filepath} (${num.format(Buffer.byteLength(body, "utf8"))} bytes, ${messages.length} message${messages.length === 1 ? "" : "s"}).`,
            metadata: {
              filepath,
              bytes: Buffer.byteLength(body, "utf8"),
              messageCount: messages.length,
              format: params.format,
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)