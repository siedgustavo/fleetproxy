import { describe, expect, test } from "bun:test";
import { OpencodeApiClient, OpencodeHttpError } from "../src/client";
import { ModelNotFoundError, OpencodeBridge, UpstreamError } from "../src/bridge";

interface FakeOptions {
  promptCalls?: Array<{ text?: string; prompt?: { text?: string } }>;
  sessionCreates?: Array<{ model: unknown; agent?: string }>;
  agentIds?: string[] | "404";
  promptFails?: boolean;
  /** imita al server 1.19.x: rechaza el body plano pidiendo la clave "prompt" */
  promptRequiresNested?: boolean;
  assistantText?: string;
  idleOutcome?: string;
  sessionTokens?: { input: number; output: number };
}

/** Fake estructural del OpencodeApiClient ruteando method+path. */
export function fakeApi(options: FakeOptions = {}): OpencodeApiClient {
  const api = {
    request: async (method: "GET" | "POST", path: string, body?: unknown) => {
      if (method === "GET" && path === "/api/provider") {
        return { data: [{ id: "github-copilot" }, { id: "fixture" }] };
      }
      if (method === "GET" && path === "/api/model") {
        return {
          data: [
            { id: "gpt-5-mini", providerID: "github-copilot", name: "GPT-5 mini", limit: { context: 400_000 } },
            { id: "echo-1", providerID: "fixture", name: "Echo One" },
            { id: "huerfano", providerID: "otro-provider", name: "Sin provider activo" },
          ],
        };
      }
      if (method === "GET" && path === "/api/agent") {
        if (options.agentIds === "404") throw new OpencodeHttpError(404, "GET /api/agent → 404");
        const ids = options.agentIds ?? ["build", "chat", "title"];
        return { data: ids.map((id) => ({ id, name: id })) };
      }
      if (method === "POST" && path === "/api/session") {
        options.sessionCreates?.push(body as { model: unknown; agent?: string });
        return { data: { id: "ses_1" } };
      }
      if (method === "POST" && path === "/api/session/ses_1/prompt") {
        const promptBody = body as { text?: string; prompt?: { text?: string } };
        if (options.promptRequiresNested && promptBody.prompt === undefined) {
          throw new OpencodeHttpError(400, 'POST prompt → 400: Missing key\n  at ["prompt"]');
        }
        options.promptCalls?.push(promptBody);
        if (options.promptFails) throw new OpencodeHttpError(400, 'POST prompt → 400: Missing key ["text"]');
        return { data: { id: "msg_1" } };
      }
      if (method === "GET" && path === "/api/session/ses_1/message") {
        return {
          data: [
            { type: "idle", outcome: options.idleOutcome ?? "succeeded" },
            {
              type: "assistant",
              time: { completed: 1 },
              content: [{ type: "text", text: options.assistantText ?? "echo: último turno" }],
            },
            { type: "user", content: [{ type: "text", text: "…" }] },
          ],
        };
      }
      if (method === "GET" && path === "/api/session/ses_1") {
        return { data: { id: "ses_1", tokens: options.sessionTokens ?? { input: 3, output: 7 } } };
      }
      throw new OpencodeHttpError(404, `${method} ${path} → 404: ruta no stubbeada en el fake`);
    },
  };
  return api as unknown as OpencodeApiClient;
}

describe("OpencodeBridge.catalog", () => {
  test("aplasta modelos a ids providerID/modelID y filtra por providers activos", async () => {
    const bridge = new OpencodeBridge(fakeApi());
    const models = await bridge.catalog();
    expect(models.map((m) => m.id)).toEqual(["github-copilot/gpt-5-mini", "fixture/echo-1"]);
    expect(models[0]?.contextWindow).toBe(400_000);
  });

  test("cachea el catálogo (TTL)", async () => {
    let calls = 0;
    const base = fakeApi();
    const client = {
      request: (method: "GET" | "POST", path: string, body?: unknown) => {
        if (path === "/api/model") calls += 1;
        return base.request(method, path, body);
      },
    } as unknown as OpencodeApiClient;
    const bridge = new OpencodeBridge(client);
    await bridge.catalog();
    await bridge.catalog();
    expect(calls).toBe(1);
  });
});

describe("OpencodeBridge.resolve", () => {
  test("acepta providerID/modelID y providerID a secas", async () => {
    const bridge = new OpencodeBridge(fakeApi());
    expect(await bridge.resolve("github-copilot/gpt-5-mini")).toEqual({
      providerID: "github-copilot",
      modelID: "gpt-5-mini",
    });
    expect(await bridge.resolve("fixture")).toEqual({ providerID: "fixture", modelID: "echo-1" });
  });

  test("provider desconocido → ModelNotFoundError", async () => {
    const bridge = new OpencodeBridge(fakeApi());
    expect(bridge.resolve("noexiste/modelo")).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});

describe("OpencodeBridge.chat", () => {
  test("session→prompt(plano)→poll idle→assistant+usage", async () => {
    const calls: Array<{ text: string }> = [];
    const bridge = new OpencodeBridge(fakeApi({ promptCalls: calls }));
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
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("sos un asistente");
    expect(calls[0]!.text).toContain("Conversación previa");
    expect(calls[0]!.text).toContain("assistant: qué tal");
    expect(calls[0]!.text.endsWith("todo bien")).toBe(true);
  });

  test("prompt rechazado → UpstreamError", async () => {
    const bridge = new OpencodeBridge(fakeApi({ promptFails: true }));
    expect(
      bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  test("server 1.x: fallback flat→nested en el body del prompt", async () => {
    const calls: NonNullable<FakeOptions["promptCalls"]> = [];
    const bridge = new OpencodeBridge(fakeApi({ promptCalls: calls, promptRequiresNested: true }));
    const result = await bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "hola" }] });
    expect(result.text).toBe("echo: último turno");
    // el intento plano rechazado no llega a registrarse; el reintentado es anidado
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt?.text).toBe("hola");
    // segunda vez va directo en nested (formato recordado)
    await bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "de nuevo" }] });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt?.text).toBe("de nuevo");
  });

  test("turno con outcome error → UpstreamError con detalle", async () => {
    const bridge = new OpencodeBridge(fakeApi({ assistantText: "", idleOutcome: "error" }));
    expect(
      bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/outcome "error"/);
  });
});

describe("OpencodeBridge agente de sesión", () => {
  test("usa el agente chat del motor y cachea la resolución", async () => {
    const creates: NonNullable<FakeOptions["sessionCreates"]> = [];
    const bridge = new OpencodeBridge(fakeApi({ sessionCreates: creates }));
    await bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "a" }] });
    await bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "b" }] });
    expect(creates.map((c) => c.agent)).toEqual(["chat", "chat"]);
  });

  test("si el motor no ofrece chat, crea la sesión sin agent (usa su default)", async () => {
    const creates: NonNullable<FakeOptions["sessionCreates"]> = [];
    const bridge = new OpencodeBridge(fakeApi({ sessionCreates: creates, agentIds: ["build", "title"] }));
    await bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "a" }] });
    expect(creates[0]!.agent).toBeUndefined();
  });

  test("404 en /api/agent no rompe el chat", async () => {
    const creates: NonNullable<FakeOptions["sessionCreates"]> = [];
    const bridge = new OpencodeBridge(fakeApi({ sessionCreates: creates, agentIds: "404" }));
    const result = await bridge.chat({ model: "fixture/echo-1", messages: [{ role: "user", content: "a" }] });
    expect(result.text).toBe("echo: último turno");
    expect(creates[0]!.agent).toBeUndefined();
  });
});
