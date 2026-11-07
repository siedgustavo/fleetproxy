import { describe, expect, test } from "bun:test";
import { CoreBridge, openaiToTurns } from "../src/core-bridge";
import { ModelNotFoundError, UpstreamError, pickModel, type CatalogModel } from "../src/bridge";
import type { Engine, EngineAskParams, EngineModelInfo } from "../src/engine";

function fakeCatalog(): CatalogModel[] {
  return [
    { id: "gitlab/duo-a", providerID: "gitlab", modelID: "duo-a" },
    { id: "gitlab/duo-b", providerID: "gitlab", modelID: "duo-b" },
    { id: "copilot/haiku", providerID: "github-copilot", modelID: "haiku" },
  ];
}

function fakeEngine(overrides: Partial<Engine> = {}) {
  const calls: { asks: EngineAskParams[]; deltas: string[]; modelsCalls: number } = { asks: [], deltas: [], modelsCalls: 0 };
  const engine: Engine = {
    async models(): Promise<EngineModelInfo[]> {
      calls.modelsCalls += 1;
      return [
        { providerID: "gitlab", modelID: "duo-a", name: "Duo A", contextWindow: 128_000 },
        { providerID: "github-copilot", modelID: "haiku" },
      ];
    },
    async ask(params, onDelta) {
      calls.asks.push(params);
      for (const piece of ["Ho", "la"]) onDelta?.(piece);
      return { text: "Hola", usage: { input: 11, output: 2, total: 13 } };
    },
    login: async () => {
      throw new Error("login no lo usa CoreBridge");
    },
    loginStatus: async () => ({ status: "pending" as const }),
    loginComplete: async () => {},
    loginCancel: async () => {},
    providers: async () => [],
    async close() {},
    ...overrides,
  };
  return { engine, calls };
}

describe("pickModel", () => {
  test("provider/model exacto, provider suelto y desconocido", () => {
    const models = fakeCatalog();
    expect(pickModel(models, "github-copilot/haiku")).toEqual({ providerID: "github-copilot", modelID: "haiku" });
    expect(pickModel(models, "gitlab")).toEqual({ providerID: "gitlab", modelID: "duo-a" });
    expect(() => pickModel(models, "noexiste/x")).toThrow(ModelNotFoundError);
  });

  test("provider conocido confia el modelo no enumerado", () => {
    expect(pickModel(fakeCatalog(), "gitlab/duo-nuevo")).toEqual({ providerID: "gitlab", modelID: "duo-nuevo" });
  });
});

describe("openaiToTurns", () => {
  test("system aparte, historial con roles reales", () => {
    const { system, turns } = openaiToTurns([
      { role: "system", content: "sos breve" },
      { role: "user", content: "hola" },
      { role: "assistant", content: "che" },
      { role: "user", content: "¿2+2?" },
    ]);
    expect(system).toBe("sos breve");
    expect(turns).toEqual([
      { role: "user", text: "hola" },
      { role: "assistant", text: "che" },
      { role: "user", text: "¿2+2?" },
    ]);
  });

  test("varios system se unen; content en partes text; rol raro viaja como user", () => {
    const { system, turns } = openaiToTurns([
      { role: "system", content: "a" },
      { role: "developer", content: "b" },
      { role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", url: "…" }] as never },
      { role: "tool", content: "resultado" },
    ]);
    expect(system).toBe("a\n\nb");
    expect(turns).toEqual([
      { role: "user", text: "x" },
      { role: "user", text: "tool: resultado" },
    ]);
  });
});

describe("CoreBridge", () => {
  test("catálogo mapeado + cacheado (TTL), forceRefresh reconsulta", async () => {
    const { engine, calls } = fakeEngine();
    const bridge = new CoreBridge(engine);
    const models = await bridge.catalog();
    expect(models[0]).toEqual({
      id: "gitlab/duo-a",
      providerID: "gitlab",
      modelID: "duo-a",
      name: "Duo A",
      contextWindow: 128_000,
    });
    await bridge.catalog();
    expect(calls.modelsCalls).toBe(1);
    await bridge.catalog(true);
    expect(calls.modelsCalls).toBe(2);
  });

  test("chat: system + turns al engine, usage al façade", async () => {
    const { engine, calls } = fakeEngine();
    const bridge = new CoreBridge(engine);
    const result = await bridge.chat({
      model: "gitlab/duo-a",
      messages: [
        { role: "system", content: "breve" },
        { role: "user", content: "hola" },
      ],
    });
    expect(calls.asks).toHaveLength(1);
    expect(calls.asks[0]).toEqual({
      providerID: "gitlab",
      modelID: "duo-a",
      system: "breve",
      turns: [{ role: "user", text: "hola" }],
    });
    expect(result.text).toBe("Hola");
    expect(result.usage).toEqual({ input: 11, output: 2, total: 13 });
  });

  test("stream reenvía los deltas en orden y el chat no los usa", async () => {
    const { engine } = fakeEngine();
    const bridge = new CoreBridge(engine);
    const deltas: string[] = [];
    const viaStream = await bridge.stream({ model: "gitlab", messages: [{ role: "user", content: "hi" }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(["Ho", "la"]);
    expect(viaStream.text).toBe("Hola");
    const viaChat = await bridge.chat({ model: "gitlab", messages: [{ role: "user", content: "hi" }] });
    expect(viaChat.text).toBe("Hola");
  });

  test("modelos sin credenciales: ask error → UpstreamError del engine propagado", async () => {
    const { engine } = fakeEngine({
      async ask() {
        throw new UpstreamError("el proveedor no devolvió texto");
      },
    });
    const bridge = new CoreBridge(engine);
    await expect(
      bridge.chat({ model: "gitlab/duo-a", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(UpstreamError);
  });

  test("request sin turnos (solo system) es UpstreamError claro", async () => {
    const { engine } = fakeEngine();
    const bridge = new CoreBridge(engine);
    await expect(bridge.chat({ model: "gitlab/duo-a", messages: [{ role: "system", content: "solo sistema" }] })).rejects.toThrow(
      /ningún turno/,
    );
  });
});
