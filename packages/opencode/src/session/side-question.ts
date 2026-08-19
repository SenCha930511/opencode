import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { SideQuestionEvent } from "@opencode-ai/schema/side-question-event"
import { LLMEvent } from "@opencode-ai/llm"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { Agent } from "../agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { Plugin } from "../plugin"
import { Instruction } from "./instruction"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SystemPrompt } from "./system"
import { MessageID, SessionID } from "./schema"

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("SideQuestion.NotFound", {
  sessionID: SessionID,
}) {
  static isInstance(input: unknown): input is NotFound {
    return input instanceof NotFound
  }
}

export class EmptyQuestion extends Schema.TaggedErrorClass<EmptyQuestion>()("SideQuestion.EmptyQuestion", {
  question: Schema.String,
}) {
  static isInstance(input: unknown): input is EmptyQuestion {
    return input instanceof EmptyQuestion
  }
}

export class UnsupportedModel extends Schema.TaggedErrorClass<UnsupportedModel>()("SideQuestion.UnsupportedModel", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
}) {
  static isInstance(input: unknown): input is UnsupportedModel {
    return input instanceof UnsupportedModel
  }
}

export type SideQuestionError = NotFound | EmptyQuestion | UnsupportedModel

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  variant: Schema.optional(Schema.String),
})

export const AskInput = Schema.Struct({
  sessionID: SessionID,
  question: Schema.String,
  model: Schema.optional(ModelRef),
  // Correlates one ask's ephemeral side_question.delta events; never echoed in the POST response.
  sideQuestionID: Schema.optional(Schema.String),
})
export type AskInput = Schema.Schema.Type<typeof AskInput>

export interface Answer {
  readonly answer: string
  readonly model: Provider.Model
  readonly createdMs: number
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<Answer, SideQuestionError | Provider.ModelNotFoundError | unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SideQuestion") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Agent.Service
  | Provider.Service
  | Plugin.Service
  | Instruction.Service
  | SystemPrompt.Service
  | LLM.Service
  | Database.Service
  | EventV2Bridge.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const instruction = yield* Instruction.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service

    // Mirrors SessionPrompt.currentModel: session row model, then the newest
    // user message carrying a model, then the provider default.
    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* database.db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const ask = Effect.fn("SideQuestion.ask")(function* (input: AskInput) {
      if (!input.question.trim()) return yield* new EmptyQuestion({ question: input.question })

      const session = yield* sessions
        .get(input.sessionID)
        .pipe(Effect.catch(() => Effect.fail(new NotFound({ sessionID: input.sessionID }))))

      const msgs = yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(
        Effect.provideService(Database.Service, database),
      )
      const lastUser = MessageV2.latest(msgs).user

      const ref = input.model ?? lastUser?.model ?? (yield* currentModel(input.sessionID))
      const model = yield* provider.getModel(ref.providerID, ref.modelID)

      // Language-model instances are cached per providerID/model.id in Provider,
      // and LLM stream mutates shared GitLab workflow instances per call, so a
      // side question against one would corrupt any in-flight run's state.
      const language = yield* provider.getLanguage(model)
      if (language instanceof GitLabWorkflowLanguageModel) {
        return yield* new UnsupportedModel({ providerID: model.providerID, modelID: model.id })
      }

      const agent = lastUser
        ? yield* agents.get(lastUser.agent)
        : session.agent
          ? yield* agents.get(session.agent)
          : yield* agents.defaultInfo()
      if (!agent) throw new NamedError.Unknown({ message: `Agent not found: "${lastUser?.agent ?? session.agent}".` })

      // The trailing user message verbatim; on an empty session, a synthetic
      // non-persisted user carrying the resolved agent/model/variant.
      const user: SessionV1.User = lastUser ?? {
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: agent.name,
        model: {
          providerID: ref.providerID,
          modelID: ref.modelID,
          variant: "variant" in ref ? ref.variant : undefined,
        },
      }

      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

      const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
        sys.skills(agent),
        sys.environment(model),
        instruction.system().pipe(Effect.orDie),
        sys.mcp(agent, session.permission),
        MessageV2.toModelMessagesEffect(msgs, model),
      ])
      const system = [
        ...env,
        ...instructions,
        ...(mcpInstructions ? [mcpInstructions] : []),
        ...(skills ? [skills] : []),
      ]

      const sideQuestionID = input.sideQuestionID ?? MessageID.ascending()
      const text = yield* llm
        .stream({
          user,
          sessionID: input.sessionID,
          model,
          agent,
          system,
          messages: [
            ...modelMsgs,
            {
              role: "user",
              content: `<side-question>\nThe user is asking a side question about this session. Answer directly and concisely from the conversation context above. You have no tools. There will be no follow-up turns: never promise to take actions, and do not modify anything. Question:\n${input.question}\n</side-question>`,
            },
          ],
          tools: {},
          toolChoice: "none",
          permission: session.permission,
        })
        .pipe(
          // Deltas publish in stream order from inside the scoped LLM stream, so
          // interrupting ask (HTTP abort) stops publishing with no post-abort events.
          Stream.tap((event) =>
            LLMEvent.is.textDelta(event)
              ? events.publish(SideQuestionEvent.Delta, {
                  sessionID: input.sessionID,
                  sideQuestionID,
                  delta: event.text,
                })
              : Effect.void,
          ),
          Stream.runFold(
            () => "",
            (text, event) => (LLMEvent.is.textDelta(event) ? text + event.text : text),
          ),
        )

      return {
        answer: text
          .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
          .replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/g, "")
          .trim(),
        model,
        createdMs: Date.now(),
      }
    })

    return Service.of({ ask })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Agent.node,
    Provider.node,
    Plugin.node,
    Instruction.node,
    SystemPrompt.node,
    LLM.node,
    Database.node,
    EventV2Bridge.node,
  ],
})

export * as SideQuestion from "./side-question"
