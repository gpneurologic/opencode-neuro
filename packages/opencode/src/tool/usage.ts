import { Effect, Schema } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import * as Tool from "./tool"
import DESCRIPTION from "./usage.txt"
import { Session } from "../session/session"
import { Provider } from "../provider/provider"

export const Parameters = Schema.Struct({})

type Metadata = {
  tokens: number
  contextLimit: number | null
  percent: number | null
  cost: number
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export const UsageTool = Tool.define<typeof Parameters, Metadata, Session.Service | Provider.Service>(
  "usage",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(ctx.sessionID)
          const cost = session.cost ?? 0

          // Mirror the sidebar (sidebar/context.tsx): the token figure comes from
          // the most recent assistant message that actually produced output.
          const last = ctx.messages.findLast(
            (m) => m.info.role === "assistant" && m.info.tokens.output > 0,
          )
          const info = last?.info.role === "assistant" ? last.info : undefined
          const tokens = info
            ? info.tokens.input +
              info.tokens.output +
              info.tokens.reasoning +
              info.tokens.cache.read +
              info.tokens.cache.write
            : 0

          const contextLimit = info
            ? yield* provider
                .getModel(ProviderV2.ID.make(info.providerID), ModelV2.ID.make(info.modelID))
                .pipe(
                  Effect.map((model) => model.limit.context || null),
                  Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(null)),
                )
            : null

          const percent = contextLimit ? Math.round((tokens / contextLimit) * 100) : null

          const output = [
            `Context: ${tokens.toLocaleString()} tokens`,
            percent !== null && contextLimit
              ? `${percent}% of the ${contextLimit.toLocaleString()}-token context window used`
              : `context window usage unknown (no model limit available)`,
            `Session cost: ${money.format(cost)} spent`,
          ].join("\n")

          return {
            title: "Usage",
            output,
            metadata: {
              tokens,
              contextLimit,
              percent,
              cost,
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
