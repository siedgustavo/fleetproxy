import type { OpencodeClient } from "@opencode-ai/sdk/v2";

export interface CatalogModel {
  /** "providerID/modelID", el id OpenAI-compatible */
  id: string;
  providerID: string;
  modelID: string;
  name?: string;
  contextWindow?: number;
}

export interface OpenAIChatMessage {
  role: string;
  content?: unknown;
}

export interface ChatResult {
  text: string;
  usage: { input: number; output: number; total: number };
}

export class ModelNotFoundError extends Error {
  constructor(model: string) {
    super(`Modelo no encontrado: ${model}`);
    this.name = "ModelNotFoundError";
  }
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return p?.type === "text" ? String(p.text ?? "") : "";
      })
      .join("");
  }
  return "";
}

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  const e = error as { message?: string; _tag?: string };
  return e.message ?? e._tag ?? JSON.stringify(error);
}

/** Extrae el texto del último mensaje assistant del historial v2. */
function lastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string;
      info?: { role?: string; error?: { message?: string; name?: string } };
      parts?: Array<{ type?: string; text?: string }>;
    };
    const role = message?.info?.role ?? message?.role;
    if (role !== "assistant") continue;
    const text = (message.parts ?? [])
      .filter((p) => p?.type === "text")
      .map((p) => String(p.text ?? ""))
      .join("");
    if (text) return text;
    const err = message.info?.error?.message ?? message.info?.error?.name;
    if (err) throw new UpstreamError(`el asistente respondió con error: ${err}`);
  }
  return null;
}

/**
 * Puerta de entrada a una instancia de opencode (API v2 del server: /api/*).
 * Todo lo que sabe fleetproxy de proveedores viene de acá: opencode carga los
 * plugins, nosotros solo preguntamos catálogo y pedimos chats vía su API.
 */
export class OpencodeBridge {
  #client: OpencodeClient;
  #catalogTtlMs: number;
  #catalog: { at: number; models: CatalogModel[] } | null = null;

  constructor(client: OpencodeClient, options: { catalogTtlMs?: number } = {}) {
    this.#client = client;
    this.#catalogTtlMs = options.catalogTtlMs ?? 30_000;
  }

  async catalog(forceRefresh = false): Promise<CatalogModel[]> {
    if (!forceRefresh && this.#catalog && Date.now() - this.#catalog.at < this.#catalogTtlMs) {
      return this.#catalog.models;
    }
    const [providers, models] = await Promise.all([this.#client.v2.provider.list(), this.#client.v2.model.list()]);
    if (providers.error && models.error) {
      throw new UpstreamError(
        `opencode /api/provider y /api/model fallaron: ${errorMessage(providers.error) ?? errorMessage(models.error)}`,
      );
    }
    const providerIds = new Set((providers.data?.data ?? []).map((p) => String(p.id)));
    const rawModels = models.data?.data ?? [];
    const catalog: CatalogModel[] = [];
    for (const model of rawModels) {
      const providerID = String(model.providerID ?? "");
      const modelID = String((model as { modelID?: string }).modelID ?? model.id ?? "");
      if (!providerID || !modelID) continue;
      // Solo providers "activos" según opencode (si la lista está vacía, no filtramos).
      if (providerIds.size > 0 && !providerIds.has(providerID)) continue;
      const info = model as { name?: string; limit?: { context?: number } };
      catalog.push({
        id: `${providerID}/${modelID}`,
        providerID,
        modelID,
        name: info.name ?? modelID,
        contextWindow: info.limit?.context,
      });
    }
    this.#catalog = { at: Date.now(), models: catalog };
    return catalog;
  }

  async resolve(rawModel: string): Promise<{ providerID: string; modelID: string }> {
    const models = await this.catalog();
    const slash = rawModel.indexOf("/");
    if (slash > 0) {
      const providerID = rawModel.slice(0, slash);
      const modelID = rawModel.slice(slash + 1);
      if (models.some((m) => m.providerID === providerID && m.modelID === modelID)) {
        return { providerID, modelID };
      }
      // Confiamos en el provider aunque el catálogo no enumere el modelo.
      if (models.some((m) => m.providerID === providerID)) return { providerID, modelID };
      throw new ModelNotFoundError(rawModel);
    }
    const providerOnly = models.filter((m) => m.providerID === rawModel);
    if (providerOnly.length > 0) return { providerID: rawModel, modelID: providerOnly[0].modelID };
    throw new ModelNotFoundError(rawModel);
  }

  /**
   * v0: sesión nueva por request (OpenAI es stateless); system + historial
   * viajan dentro del texto del prompt. Sesiones persistentes por header
   * llegan en un hito posterior.
   */
  async chat(params: { model: string; messages: OpenAIChatMessage[] }): Promise<ChatResult> {
    const { providerID, modelID } = await this.resolve(params.model);

    const systems: string[] = [];
    const transcript: string[] = [];
    let lastUser: string | null = null;
    for (let i = 0; i < params.messages.length; i++) {
      const message = params.messages[i];
      const isLast = i === params.messages.length - 1;
      const text = textOf(message.content);
      if (message.role === "system") {
        systems.push(text);
        continue;
      }
      if (isLast && message.role === "user") {
        lastUser = text;
        continue;
      }
      transcript.push(`${message.role}: ${text}`);
    }
    if (lastUser === null) lastUser = textOf(params.messages[params.messages.length - 1]?.content);

    const sections: string[] = [...systems];
    if (transcript.length > 0) sections.push(`Conversación previa (transcripción):\n${transcript.join("\n")}`);
    const promptText = [...sections, lastUser].filter((s) => s && s.length > 0).join("\n\n");

    const created = await this.#client.v2.session.create({ model: { id: modelID, providerID } });
    // El cuerpo 200 de /api/session es { data: SessionV2Info } → doble unwrap.
    const sessionID = created.data?.data?.id;
    if (!sessionID) {
      throw new UpstreamError(`opencode session.create() falló: ${errorMessage(created.error) ?? "sin data"}`);
    }

    const admitted = await this.#client.v2.session.prompt({ sessionID, prompt: { text: promptText } });
    if (admitted.error) {
      throw new UpstreamError(`prompt rechazado: ${errorMessage(admitted.error)}`);
    }

    const waited = await this.#client.v2.session.wait({ sessionID });
    if (waited.error) {
      throw new UpstreamError(`session.wait falló: ${errorMessage(waited.error)}`);
    }

    const history = await this.#client.v2.session.messages({ sessionID });
    if (history.error) {
      throw new UpstreamError(`session.messages falló: ${errorMessage(history.error)}`);
    }
    const text = lastAssistantText(history.data?.data ?? []);
    if (text === null) {
      throw new UpstreamError(`el asistente no dejó texto en la sesión ${sessionID}`);
    }

    const session = await this.#client.v2.session.get({ sessionID });
    const tokens = session.data?.data?.tokens ?? { input: 0, output: 0 };
    const input = tokens.input ?? 0;
    const output = tokens.output ?? 0;
    return { text, usage: { input, output, total: input + output } };
  }
}
