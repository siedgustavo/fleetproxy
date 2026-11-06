import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { ModelNotFoundError, OpencodeBridge, UpstreamError } from "../src/bridge";

export interface PromptCall {
  sessionID: string;
  prompt?: { text: string };
}

interface FakeOptions {
  promptCalls?: PromptCall[];
  promptError?: unknown;
  assistantText?: string;
  assistantError?: { message?: string; name?: string };
  sessionTokens?: { input: number; output: number };
}

export function fakeClient(options: FakeOptions = {}): OpencodeClient {
  const sessionID = "ses_1";
  const v2 = {
    provider: {
      list: async () => ({
        data: { location: {}, data: [{ id: "github-copilot" }, { id: "fixture" }] },
        error: undefined,
      }),
    },
    model: {
      list: async () => ({
        data: {
          location: {},
          data: [
            {
              id: "gpt-5-mini",
              providerID: "github-copilot",
              name: "GPT-5 mini",
              limit: { context: 400_000 },
            },
            { id: "echo-1", providerID: "fixture", name: "Echo One" },
            { id: "huerfano", providerID: "otro-provider", name: "Sin provider activo" },
          ],
        },
        error: undefined,
      }),
    },
    session: {
      create: async () => ({ data: { data: { id: sessionID, tokens: { input: 0, output: 0 } } }, error: undefined }),
      prompt: async (params: PromptCall) => {
        options.promptCalls?.push(params);
        if (options.promptError) return { data: undefined, error: options.promptError };
        return { data: {}, error: undefined };
      },
      wait: async () => ({ data: undefined, error: undefined }),
      messages: async () => ({
        data: {
          cursor: {},
          data: [
            {
              info: { role: "user" },
              parts: [{ type: "text", text: "…" }],
            },
            {
              info: { role: "assistant", error: options.assistantError },
              parts: [{ type: "text", text: options.assistantText ?? `echo: último turno` }],
            },
          ],
        },
        error: undefined,
      }),
      get: async () => ({
        data: { data: { id: sessionID, tokens: options.sessionTokens ?? { input: 3, output: 7 } } },
        error: undefined,
      }),
    },
  };
  return { v2 } as unknown as OpencodeClient;
}

describe("OpencodeBridge.catalog", () => {
  test("aplasta modelos a ids providerID/modelID y filtra por providers activos", async () => {
    const bridge = new OpencodeBridge(fakeClient());
    const models = await bridge.catalog();
    expect(models.map((m) => m.id)).toEqual(["github-copilot/gpt-5-mini", "fixture/echo-1"]);
    expect(models[0]?.contextWindow).toBe(400_000);
  });

  test("cachea el catálogo (TTL)", async () => {
    let calls = 0;
    const base = fakeClient() as unknown as { v2: { model: { list: () => Promise<unknown> } } };
    const client = {
      ...(base as object),
      v2: {
        ...(base as any).v2,
        model: {
          list: async () => {
            calls += 1;
            return (base as any).v2.model.list();
          },
        },
      },
    } as unknown as OpencodeClient;
    const bridge = new OpencodeBridge(client);
    await bridge.catalog();
    await bridge.catalog();
    expect(calls).toBe(1);
  });
});

describe("OpencodeBridge.resolve", () => {
  test("acepta providerID/modelID y providerID a secas", async () => {
    const bridge = new OpencodeBridge(fakeClient());
    expect(await bridge.resolve("github-copilot/gpt-5-mini")).toEqual({
      providerID: "github-copilot",
      modelID: "gpt-5-mini",
    });
    expect(await bridge.resolve("fixture")).toEqual({ providerID: "fixture", modelID: "echo-1" });
  });

  test("provider desconocido → ModelNotFoundError", async () => {
    const bridge = new OpencodeBridge(fakeClient());
    expect(bridge.resolve("noexiste/modelo")).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});

describe("OpencodeBridge.chat", () => {
  test("create→prompt→wait→messages→get: texto y usage", async () => {
    const calls: PromptCall[] = [];
    const bridge = new OpencodeBridge(fakeClient({ promptCalls: calls }));
    const result = await bridge.chat({
      model: "github-copilot/gpt-5-mini",
      messages: [
        { role: "system", content: "sos un asistente" },
        { role: "user", content: "hola" },
        { role: "assistant", content: "qué tal" },
        { role: "user", content: "todo bien" },
      ],
    });
    expect(result.text).toBe("echo: último turno");
    expect(result.usage).toEqual({ input: 3, output: 7, total: 10 });
    const call = calls[0]!;
    expect(call.sessionID).toBe("ses_1");
    expect(call.prompt?.text).toContain("sos un asistente");
    expect(call.prompt?.text).toContain("Conversación previa");
    expect(call.prompt?.text).toContain("assistant: qué tal");
    expect(call.prompt?.text.endsWith("todo bien")).toBe(true);
  });

  test("prompt rechazado → UpstreamError", async () => {
    const bridge = new OpencodeBridge(fakeClient({ promptError: { _tag: "ProviderNotFoundError" } }));
    expect(
      bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  test("error en el mensaje del asistente → UpstreamError con detalle", async () => {
    const bridge = new OpencodeBridge(
      fakeClient({ assistantText: "", assistantError: { message: "cuota agotada" } }),
    );
    expect(
      bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/cuota agotada/);
  });
});
