/**
 * Bridge sobre el motor in-process (@opencode/core vía Engine). A diferencia
 * del bridge HTTP, los mensajes OpenAI no se transcriptan: el system viaja
 * como system y el historial conserva sus roles reales (1 sola llamada al
 * proveedor, sin agent loop).
 */
import {
  ModelNotFoundError,
  UpstreamError,
  pickModel,
  textOf,
  type Bridge,
  type CatalogModel,
  type ChatResult,
  type OpenAIChatMessage,
} from "./bridge";
import type { Engine, EngineTurn } from "./engine";

export interface CoreBridgeOptions {
  catalogTtlMs?: number;
}

/**
 * Abre los mensajes OpenAI en system (unido) + turnos con roles reales.
 * Roles exóticos (tool/function, …) viajan como user con el rol al frente,
 * como hacíamos con el motor por HTTP: nada se pierde.
 */
export function openaiToTurns(messages: OpenAIChatMessage[]): { system?: string; turns: EngineTurn[] } {
  const systems: string[] = [];
  const turns: EngineTurn[] = [];
  for (const message of messages) {
    const text = textOf(message.content);
    const role = String(message.role ?? "").toLowerCase();
    if (role === "system" || role === "developer") {
      if (text) systems.push(text);
      continue;
    }
    if (!text) continue;
    if (role === "user" || role === "assistant") turns.push({ role, text });
    else turns.push({ role: "user", text: `${role}: ${text}` });
  }
  return { system: systems.length > 0 ? systems.join("\n\n") : undefined, turns };
}

export class CoreBridge implements Bridge {
  #engine: Engine;
  #catalogTtlMs: number;
  #catalog: { at: number; models: CatalogModel[] } | null = null;

  constructor(engine: Engine, options: CoreBridgeOptions = {}) {
    this.#engine = engine;
    this.#catalogTtlMs = options.catalogTtlMs ?? 30_000;
  }

  async catalog(forceRefresh = false): Promise<CatalogModel[]> {
    if (!forceRefresh && this.#catalog && Date.now() - this.#catalog.at < this.#catalogTtlMs) {
      return this.#catalog.models;
    }
    let infos;
    try {
      infos = await this.#engine.models();
    } catch (error) {
      throw new UpstreamError(error instanceof Error ? error.message : String(error));
    }
    const catalog: CatalogModel[] = infos.map((m) => ({
      id: `${m.providerID}/${m.modelID}`,
      providerID: m.providerID,
      modelID: m.modelID,
      name: m.name ?? m.modelID,
      contextWindow: m.contextWindow,
    }));
    this.#catalog = { at: Date.now(), models: catalog };
    return catalog;
  }

  async resolve(rawModel: string): Promise<{ providerID: string; modelID: string }> {
    return pickModel(await this.catalog(), rawModel);
  }

  async chat(params: { model: string; messages: OpenAIChatMessage[] }): Promise<ChatResult> {
    return this.stream(params);
  }

  async stream(
    params: { model: string; messages: OpenAIChatMessage[] },
    onDelta?: (delta: string) => void,
  ): Promise<ChatResult> {
    const { providerID, modelID } = await this.resolve(params.model);
    const { system, turns } = openaiToTurns(params.messages);
    if (turns.length === 0) throw new UpstreamError("el request no tiene ningún turno user/assistant con texto");
    return this.#engine.ask({ providerID, modelID, system, turns }, onDelta);
  }
}

export { ModelNotFoundError };
