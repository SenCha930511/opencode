import { afterEach, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { streamText } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

it.live("headerTimeout does not abort delayed SSE body after headers arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(1_000)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("late")
        }),
      { config: providerConfig(server.url, { headerTimeout: 500 }) },
    )
  }),
)

for (const timeout of ["chunkTimeout", "headerTimeout"] as const) {
  it.live(`default ${timeout} is applied at fetch without changing provider options`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => delayedBodyServer(250)),
        (server) => Effect.sync(() => server.server.close()),
      )

      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
            const signals: (AbortSignal | null | undefined)[] = []
            configured.options.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
              signals.push(init?.signal)
              return fetch(input, init)
            }
            const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            const language = yield* provider.getLanguage(model)
            yield* Effect.acquireRelease(
              Effect.promise(() =>
                language.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
              ),
              (result) => Effect.promise(() => result.stream.cancel()),
            )

            expect(signals).toHaveLength(1)
            expect(signals[0]).toBeInstanceOf(AbortSignal)
            expect(configured.options[timeout]).toBeUndefined()
          }),
        {
          config: providerConfig(server.url, {
            [timeout === "chunkTimeout" ? "headerTimeout" : "chunkTimeout"]: false,
          }),
        },
      )
    }),
  )
}

it.live("configured chunkTimeout raises a retryable response stream error when SSE body stalls", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const error = yield* Effect.promise(async () => {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "error") return part.error
              }
            } catch (error) {
              return error
            }
          })
          expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
          expect(
            SessionRetry.retryable(MessageV2.fromError(error, { providerID: model.providerID }), model.providerID),
          ).toEqual({ message: "SSE read timed out" })
        }),
      { config: providerConfig(server.url, { chunkTimeout: 50, stallRetry: false }) },
    )
  }),
)

it.live("chunkTimeout can be disabled with false", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const configured = yield* provider.getProvider(ProviderV2.ID.make("test"))
          expect(configured.options.chunkTimeout).toBe(false)
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("late")
        }),
      { config: providerConfig(server.url, { chunkTimeout: false }) },
    )
  }),
)

it.live("headerTimeout aborts when response headers do not arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(250)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const errors = yield* Effect.promise(async () => {
            const errors: string[] = []
            for await (const part of result.fullStream) {
              if (part.type === "error") errors.push(String(part.error))
            }
            return errors
          })
          expect(errors.join("\n")).toContain("response headers timed out")
        }),
      { config: providerConfig(server.url, { headerTimeout: 50, stallRetry: false }) },
    )
  }),
)

it.live("headerTimeout can be disabled with false for non-OpenAI providers", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(100)),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("ok")
        }),
      { config: providerConfig(server.url, { headerTimeout: false }) },
    )
  }),
)

it.live("OpenAI Codex header and chunk timeout defaults can be disabled by config", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const openai = yield* provider.getProvider(ProviderV2.ID.openai)
              expect(openai.options.headerTimeout).toBe(false)
              expect(openai.options.chunkTimeout).toBe(false)
            }),
          { config: { provider: { openai: { options: { headerTimeout: false, chunkTimeout: false } } } } },
        )
      }),
    )
  }),
)

it.live("OpenAI API auth gets default headerTimeout", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const openai = yield* provider.getProvider(ProviderV2.ID.openai)
            expect(openai.options.headerTimeout).toBe(300_000)
          }),
        )
      }),
      { openai: { type: "api", key: "sk-test" } },
    )
  }),
)

function providerConfig(url: string, options: Record<string, unknown> = {}) {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        options: { ...config.provider.test.options, ...options },
      },
    },
  }
}

async function delayedHeaderServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function delayedBodyServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    setTimeout(() => {
      res.end('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function withAuthContent<A, E, R>(self: Effect.Effect<A, E, R>, value: Record<string, unknown> = defaultAuthContent()) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(value)
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }),
  )
}

function defaultAuthContent() {
  return {
    openai: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
  }
}

// --- stall retry ---

it.live("stallRetry retries with stream:false when SSE ends without finish_reason", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => stallRetryServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("partial\nrecovered")
          expect(server.nonStreamHits).toBe(1)
        }),
      { config: providerConfig(server.url, { stallRetry: true }) },
    )
  }),
)

it.live("stallRetry does not retry when SSE ends properly with finish_reason", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => properStreamServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("ok")
          expect(server.nonStreamHits).toBe(0)
        }),
      { config: providerConfig(server.url, { stallRetry: true }) },
    )
  }),
)

async function stallRetryServer(): Promise<{ server: Server; url: string; nonStreamHits: number }> {
  let nonStreamHits = 0
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      let parsed: any = {}
      try { parsed = JSON.parse(body) } catch {}
      if (parsed.stream === false) {
        nonStreamHits++
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          id: "retry-1",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "recovered" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }))
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"id":"stall-1","created":1,"model":"test-model","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"}}]}\n\n')
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind")
  return { server, url: `http://127.0.0.1:${address.port}`, get nonStreamHits() { return nonStreamHits } }
}

async function properStreamServer(): Promise<{ server: Server; url: string; nonStreamHits: number }> {
  let nonStreamHits = 0
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"id":"ok-1","created":1,"model":"test-model","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n')
      res.write('data: {"id":"ok-1","created":1,"model":"test-model","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind")
  return { server, url: `http://127.0.0.1:${address.port}`, get nonStreamHits() { return nonStreamHits } }
}

it.live("stallRetry recovers when response headers time out", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => headerHangServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("recovered")
          expect(server.nonStreamHits).toBe(1)
        }),
      { config: providerConfig(server.url, { headerTimeout: 50, stallRetry: true }) },
    )
  }),
)

it.live("stallRetry recovers when SSE body stalls mid-stream with open connection", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => midStreamHangServer()),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("partial continued")
          expect(server.nonStreamHits).toBe(1)
        }),
      { config: providerConfig(server.url, { chunkTimeout: 50, stallRetry: true }) },
    )
  }),
)

async function headerHangServer(): Promise<{ server: Server; url: string; nonStreamHits: number }> {
  let nonStreamHits = 0
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      let parsed: any = {}
      try { parsed = JSON.parse(body) } catch {}
      if (parsed.stream === false) {
        nonStreamHits++
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          id: "retry-1",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "recovered" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }))
      } else {
        // Never write headers — simulates server hang before first byte.
        // Connection sits idle until headerTimeout aborts the fetch.
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind")
  return { server, url: `http://127.0.0.1:${address.port}`, get nonStreamHits() { return nonStreamHits } }
}

async function midStreamHangServer(): Promise<{ server: Server; url: string; nonStreamHits: number }> {
  let nonStreamHits = 0
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      let parsed: any = {}
      try { parsed = JSON.parse(body) } catch {}
      if (parsed.stream === false) {
        nonStreamHits++
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          id: "retry-1",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "partial continued" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }))
      } else {
        // Send partial content then hold the connection open forever —
        // simulates vLLM streaming parser stall mid-stream.
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"id":"hang-1","created":1,"model":"test-model","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"}}]}\n\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind")
  return { server, url: `http://127.0.0.1:${address.port}`, get nonStreamHits() { return nonStreamHits } }
}
