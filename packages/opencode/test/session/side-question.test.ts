import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SideQuestionEvent } from "@opencode-ai/schema/side-question-event"
import { expect } from "bun:test"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SideQuestion } from "../../src/session/side-question"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer, raw, reply } from "../lib/llm-server"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in side-question tests"),
    authenticate: () => Effect.die("unexpected MCP auth in side-question tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in side-question tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

// Captures every LLM.Service.stream input so tests can assert the exact
// contract SideQuestion hands to the LLM service (tools, toolChoice, user).
const streams: LLM.StreamInput[] = []

const sideQuestionSpy = LayerNode.make({
  service: SideQuestion.Service,
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const llm = yield* LLM.Service
      const spied = LLM.Service.of({
        stream: (input: LLM.StreamInput) => {
          streams.push(input)
          return llm.stream(input)
        },
      })
      return SideQuestion.layer.pipe(Layer.provide(Layer.succeed(LLM.Service, spied)))
    }),
  ),
  deps: [
    LLM.node,
    Session.node,
    AgentSvc.node,
    ProviderSvc.node,
    Plugin.node,
    Instruction.node,
    SystemPrompt.node,
    Database.node,
    EventV2Bridge.node,
  ],
})

const root = LayerNode.group([
  sideQuestionSpy,
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  testLLMServerNode,
])

const layer = LayerNode.compile(root, [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
])

const it = testEffect(layer)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// Config that registers a custom "test" provider with a "test-model" model so
// provider model lookup succeeds. Mirrors prompt.test.ts.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

// Title-generation requests are auto-answered by TestLLMServer without
// consuming the reply queue; they must be excluded from request assertions.
const isTitle = (body: unknown) => JSON.stringify(body).includes("Generate a title for this conversation")

type Captured = { messages?: unknown; [key: string]: unknown }

// Deep-snapshot captured (non-title) request bodies as JSON at capture time.
const captured = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const inputs = yield* llm.inputs
  return inputs.filter((body) => !isTitle(body)).map((body) => JSON.parse(JSON.stringify(body)) as Captured)
})

const sideInput = (sessionID: SessionID) => {
  const input = streams.find((s) => s.sessionID === sessionID && s.toolChoice === "none")
  if (!input) throw new Error("side-question stream input was not captured")
  return input
}

const wrap = (question: string) =>
  `<side-question>\nThe user is asking a side question about this session. Answer directly and concisely from the conversation context above. You have no tools. There will be no follow-up turns: never promise to take actions, and do not modify anything. Question:\n${question}\n</side-question>`

it.instance(
  "answer returns text while leaving session messages and session row untouched",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const side = yield* SideQuestion.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "SideA" })
      yield* seed(chat.id)

      const before = yield* sessions.messages({ sessionID: chat.id })
      const ids = before.map((m) => m.info.id)
      const updated = (yield* sessions.get(chat.id)).time.updated

      yield* llm.text("side-answer")
      const out = yield* side.ask({ sessionID: chat.id, question: "what did the user say?" })

      expect(out.answer).toBe("side-answer")
      expect(out.model.id).toBe(ref.modelID)
      expect(out.model.providerID).toBe(ref.providerID)
      expect(typeof out.createdMs).toBe("number")

      const after = yield* sessions.messages({ sessionID: chat.id })
      expect(after.map((m) => m.info.id)).toEqual(ids)
      expect(after).toHaveLength(before.length)
      expect((yield* sessions.get(chat.id)).time.updated).toBe(updated)
    }),
  15_000,
)

it.instance(
  "stream request disables tools and tool choice, wrapper question is the last turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const side = yield* SideQuestion.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "SideB" })
      yield* seed(chat.id)

      yield* llm.text("answer")
      yield* side.ask({ sessionID: chat.id, question: "summarize the turn" })

      // StreamInput contract handed to LLM.Service.stream.
      const input = sideInput(chat.id)
      expect(input.tools).toEqual({})
      expect(input.toolChoice).toBe("none")

      const bodies = yield* captured
      expect(bodies).toHaveLength(1)
      const body = bodies[0]
      // The wire request omits both keys when zero tools are offered
      // (@ai-sdk/openai-compatible drops tools/tool_choice for an empty tool list).
      expect("tools" in body).toBe(false)
      expect("tool_choice" in body).toBe(false)
      const messages = body.messages
      if (!Array.isArray(messages)) throw new Error("expected messages array in LLM request")
      expect(messages.at(-1)).toEqual({ role: "user", content: wrap("summarize the turn") })
      expect(messages.at(-2)).toEqual({ role: "assistant", content: "hi there" })
      expect(messages.at(-3)).toEqual({ role: "user", content: "hello" })
    }),
  15_000,
)

it.instance(
  "context matches the main loop system array and history prefix",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const side = yield* SideQuestion.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "SideC",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")
      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const [mainReq] = yield* captured

      yield* llm.text("side-answer")
      const out = yield* side.ask({ sessionID: chat.id, question: "repeat the question" })
      expect(out.answer).toBe("side-answer")

      const [, sideReq] = yield* captured
      const mainMsgs = mainReq.messages
      const sideMsgs = sideReq.messages
      if (!Array.isArray(mainMsgs) || !Array.isArray(sideMsgs)) {
        throw new Error("expected messages array in LLM requests")
      }
      const system = (msgs: unknown[]) => msgs.filter((m) => (m as { role?: string }).role === "system")

      // Parity is vacuous without a non-empty compared history.
      expect(mainMsgs.length).toBeGreaterThan(0)
      expect(system(mainMsgs).length).toBeGreaterThan(0)
      expect(system(sideMsgs)).toEqual(system(mainMsgs))
      // The entire main-loop request is an exact prefix of the side-question
      // request; only the completed assistant turn and the wrapper were appended.
      expect(sideMsgs.slice(0, mainMsgs.length)).toEqual(mainMsgs)
      expect(sideMsgs.at(-1)).toEqual({ role: "user", content: wrap("repeat the question") })
      expect(sideMsgs.at(-2)).toEqual({ role: "assistant", content: "world" })
    }),
  15_000,
)

it.instance("unknown session yields SideQuestionError.NotFound", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const side = yield* SideQuestion.Service
    const err = yield* side
      .ask({ sessionID: SessionID.make("ses_sidequestion_missing"), question: "hello?" })
      .pipe(Effect.flip)
    if (!SideQuestion.NotFound.isInstance(err)) throw new Error(`expected NotFound, got ${String(err)}`)
    expect(err._tag).toBe("SideQuestion.NotFound")
    expect(yield* llm.calls).toBe(0)
  }),
)

it.instance("blank questions yield SideQuestionError.EmptyQuestion before any model work", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const side = yield* SideQuestion.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "SideE" })
    yield* seed(chat.id)

    for (const question of ["", "   ", "\n\t  "]) {
      const err = yield* side.ask({ sessionID: chat.id, question }).pipe(Effect.flip)
      if (!SideQuestion.EmptyQuestion.isInstance(err)) {
        throw new Error(`expected EmptyQuestion for ${JSON.stringify(question)}, got ${String(err)}`)
      }
    }
    // Precedence: a blank question fails before the session lookup runs.
    const err = yield* side
      .ask({ sessionID: SessionID.make("ses_sidequestion_missing"), question: "  " })
      .pipe(Effect.flip)
    if (!SideQuestion.EmptyQuestion.isInstance(err)) throw new Error(`expected EmptyQuestion, got ${String(err)}`)

    expect(yield* llm.calls).toBe(0)
    expect(streams.filter((s) => s.sessionID === chat.id)).toHaveLength(0)
  }),
)

it.instance(
  "answers while a main run is held open and leaves its history untouched",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const side = yield* SideQuestion.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({
        title: "SideF",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.hold("parent-answer", deferredAsPromise(gate))
      yield* llm.text("side-answer")

      const parent = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "first" }] })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)

      // During the hold: the user message plus the pending assistant placeholder.
      const ids = (yield* sessions.messages({ sessionID: chat.id })).map((m) => m.info.id)
      expect(ids).toHaveLength(2)

      const out = yield* side.ask({ sessionID: chat.id, question: "what is the user asking?" })
      expect(out.answer).toBe("side-answer")
      // The main run is still in flight — the side question completed during it.
      expect((yield* status.get(chat.id)).type).toBe("busy")

      yield* Deferred.succeed(gate, void 0)
      const exit = yield* Fiber.await(parent)
      expect(Exit.isSuccess(exit)).toBe(true)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      expect(msgs).toHaveLength(2)
      const usr = msgs[0]
      const assistant = msgs[1]
      if (!usr || !assistant) throw new Error("expected user and assistant messages")
      expect(usr.info.id).toBe(ids[0])
      expect(usr.info.role).toBe("user")
      expect(assistant.info.role).toBe("assistant")
      expect(assistant.parts.some((p) => p.type === "text" && p.text.includes("parent-answer"))).toBe(true)
      expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("side-answer")))).toBe(false)
      expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("<side-question>")))).toBe(false)
    }),
  20_000,
)

it.instance(
  "empty session answers through a synthesized non-persisted user",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const side = yield* SideQuestion.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "SideG",
        agent: "build",
        model: { providerID: ref.providerID, id: ref.modelID },
      })

      yield* llm.text("empty-answer")
      const out = yield* side.ask({ sessionID: chat.id, question: "where are we?" })
      expect(out.answer).toBe("empty-answer")

      const input = sideInput(chat.id)
      expect(input.user.role).toBe("user")
      expect(input.user.sessionID).toBe(chat.id)
      expect(input.user.agent).toBe("build")
      expect(input.user.model.providerID).toBe(ref.providerID)
      expect(input.user.model.modelID).toBe(ref.modelID)

      expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(0)

      const bodies = yield* captured
      expect(bodies).toHaveLength(1)
      const messages = bodies[0].messages
      if (!Array.isArray(messages)) throw new Error("expected messages array in LLM request")
      // No fabricated history: only system context plus the wrapper turn.
      expect(messages.filter((m) => (m as { role?: string }).role !== "system")).toEqual([
        { role: "user", content: wrap("where are we?") },
      ])
    }),
  15_000,
)

type CapturedDelta = { sideQuestionID: string; delta: string }

// Listen registration is eager (the SSE handler relies on the same property),
// so subscribing before ask() cannot miss deltas the way a forked stream
// consumer could.
const subscribeDeltas = Effect.fn("test.subscribeDeltas")(function* (sessionID: SessionID, deltas: CapturedDelta[]) {
  const events = yield* EventV2Bridge.Service
  const unsubscribe = yield* events.listen((event) =>
    Effect.sync(() => {
      if (event.type !== SideQuestionEvent.Delta.type) return
      const data = Schema.decodeUnknownSync(SideQuestionEvent.Delta.data)(event.data)
      if (data.sessionID !== sessionID) return
      deltas.push({ sideQuestionID: data.sideQuestionID, delta: data.delta })
    }),
  )
  yield* Effect.addFinalizer(() => unsubscribe)
})

it.instance(
  "deltas publish in stream order, concatenate to the answer, and carry the caller's sideQuestionID",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const side = yield* SideQuestion.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "SideDelta" })
      yield* seed(chat.id)

      const deltas: CapturedDelta[] = []
      yield* subscribeDeltas(chat.id, deltas)

      yield* llm.push(reply().text("alpha-").text("beta-").text("gamma").stop())
      const out = yield* side.ask({ sessionID: chat.id, question: "spell the parts", sideQuestionID: "sq-caller-42" })

      expect(out.answer).toBe("alpha-beta-gamma")
      expect(deltas.map((d) => d.delta)).toEqual(["alpha-", "beta-", "gamma"])
      expect(deltas.map((d) => d.delta).join("")).toBe(out.answer)
      expect(new Set(deltas.map((d) => d.sideQuestionID))).toEqual(new Set(["sq-caller-42"]))
    }),
  15_000,
)

// The chunk shapes below mirror the OpenAI wire lines the private test-lib
// builders produce so raw() can emit one delta, hold, then offer a second.
const roleChunk = () => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta: { role: "assistant" } }],
})
const textChunk = (content: string) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta: { content } }],
})
const stopChunk = () => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta: {}, finish_reason: "stop" }],
})

it.instance(
  "interrupting an ask mid-stream stops delta publishing and the ask rejects",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const side = yield* SideQuestion.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "SideAbort" })
      yield* seed(chat.id)

      const deltas: CapturedDelta[] = []
      yield* subscribeDeltas(chat.id, deltas)

      const gate = yield* Deferred.make<void>()
      yield* llm.push(
        raw({
          chunks: [roleChunk(), textChunk("first-half-")],
          tail: [textChunk("second-half"), stopChunk()],
          wait: deferredAsPromise(gate),
        }),
      )

      const asking = yield* side.ask({ sessionID: chat.id, question: "tell me something" }).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.sync(() => (deltas.length === 1 ? (true as const) : undefined)),
        "no side-question delta arrived",
      )

      yield* Fiber.interrupt(asking)
      const exit = yield* Fiber.await(asking)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(deltas.map((d) => d.delta)).toEqual(["first-half-"])

      yield* Deferred.succeed(gate, void 0)
      // The negative half of the assertion: give the now-released server stream a
      // wall-clock window to flush; a live consumer would observe "second-half"
      // within it (mirrors the flushed() settle window of the TUI glass tests).
      yield* Effect.sleep("200 millis")
      expect(deltas.map((d) => d.delta)).toEqual(["first-half-"])
    }),
  15_000,
)

// GitLab-workflow guard (assertion (h) from the plan): side-question.ts must
// yield SideQuestionError.UnsupportedModel after provider.getLanguage when the
// language-model instance is a GitLabWorkflowLanguageModel — those instances
// are cached per providerID/model.id in Provider and llm.ts mutates the shared
// instance per stream call, so streaming one from a side question would corrupt
// any in-flight run using the same model. The test harness has no fixture that
// can register a workflow-model language model (test/provider/gitlab-duo.test.ts
// is entirely disabled and loading the gitlab provider requires GITLAB_TOKEN),
// and faking one is out of scope per the plan: the orchestrator's F2 gate covers
// the behavioral UnsupportedModel + zero-requests assertion. This comment is
// the deliberate in-suite pointer to that guard code path.
