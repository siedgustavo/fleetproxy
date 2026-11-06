import { OpencodeApiClient, OpencodeHttpError } from "./client";

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

interface ServerMessage {
  type?: string;
  outcome?: string;
  time?: { created?: number; completed?: number };
  content?: Array<{ type?: string; text?: string }>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BridgeOptions {
  catalogTtlMs?: number;
  /** máx a esperar el mensaje idle del turno */
  completionTimeoutMs?: number;
  completionPollMs?: number;
}

/**
 * Puerta de entrada a una instancia de opencode (API v2 del server, /api/*).
 * Todo lo que sabe fleetproxy de proveedores viene de acá: opencode carga los
 * plugins, nosotros solo preguntamos catálogo y pedimos chats vía su API.
 */
export class OpencodeBridge {
  #api: OpencodeApiClient;
  #catalogTtlMs: number;
  #completionTimeoutMs: number;
  #completionPollMs: number;
  #catalog: { at: number; models: CatalogModel[] } | null = null;

  constructor(api: OpencodeApiClient, options: BridgeOptions = {}) {
    this.#api = api;
    this.#catalogTtlMs = options.catalogTtlMs ?? 30_000;
    this.#completionTimeoutMs = options.completionTimeoutMs ?? 120_000;
    this.#completionPollMs = options.completionPollMs ?? 500;
  }

  async catalog(forceRefresh = false): Promise<CatalogModel[]> {
    if (!forceRefresh && this.#catalog && Date.now() - this.#catalog.at < this.#catalogTtlMs) {
      return this.#catalog.models;
    }
    try {
      const [providers, models] = await Promise.all([
        this.#api.request<{ data?: Array<{ id?: string }> }>("GET", "/api/provider"),
        this.#api.request<{ data?: Array<Record<string, unknown>> }>("GET", "/api/model"),
      ]);
      const providerIds = new Set((providers?.data ?? []).map((p) => String(p.id)));
      const catalog: CatalogModel[] = [];
      for (const model of models?.data ?? []) {
        const providerID = String((model.providerID as string | undefined) ?? "");
        const modelID = String((model.modelID as string | undefined) ?? (model.id as string | undefined) ?? "");
        if (!providerID || !modelID) continue;
        // Solo providers "activos" según opencode (si la lista está vacía, no filtramos).
        if (providerIds.size > 0 && !providerIds.has(providerID)) continue;
        const limit = model.limit as { context?: number } | undefined;
        catalog.push({
          id: `${providerID}/${modelID}`,
          providerID,
          modelID,
          name: (model.name as string | undefined) ?? modelID,
          contextWindow: limit?.context,
        });
      }
      this.#catalog = { at: Date.now(), models: catalog };
      return catalog;
    } catch (error) {
      throw this.#mapError(error);
    }
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

    try {
      const created = await this.#api.request<{ data?: { id?: string } }>("POST", "/api/session", {
        model: { id: modelID, providerID },
      });
      const sessionID = created?.data?.id;
      if (!sessionID) throw new UpstreamError("opencode no devolvió id de sesión");

      // El server 2.2.x espera el PromptInput PLANO en el body.
      await this.#api.request("POST", `/api/session/${sessionID}/prompt`, { text: promptText });

      const messages = await this.#awaitTurnCompletion(sessionID);
      const assistant = messages.find((m) => m?.type === "assistant");
      const assistantText = (assistant?.content ?? [])
        .filter((c) => c?.type === "text")
        .map((c) => String(c.text ?? ""))
        .join("");
      if (!assistantText) throw new UpstreamError(`el asistente no dejó texto en la sesión ${sessionID}`);

      const session = await this.#api.request<{ data?: { tokens?: { input?: number; output?: number } } }>(
        "GET",
        `/api/session/${sessionID}`,
      );
      const input = session?.data?.tokens?.input ?? 0;
      const output = session?.data?.tokens?.output ?? 0;
      return { text: assistantText, usage: { input, output, total: input + output } };
    } catch (error) {
      throw this.#mapError(error);
    }
  }

  /**
   * Polling de /message hasta que aparezca el mensaje "idle" del turno
   * (señal de término en opencode 2.2.x; /wait no existe). El array viene
   * newest-first.
   */
  async #awaitTurnCompletion(sessionID: string): Promise<ServerMessage[]> {
    const deadline = Date.now() + this.#completionTimeoutMs;
    for (;;) {
      const page = await this.#api.request<{ data?: ServerMessage[] }>(
        "GET",
        `/api/session/${sessionID}/message`,
      );
      const messages = page?.data ?? [];
      const newest = messages[0];
      if (newest?.type === "idle") {
        if (newest.outcome && newest.outcome !== "succeeded") {
          throw new UpstreamError(`el turno terminó con outcome "${newest.outcome}"`);
        }
        return messages;
      }
      // Fallback: assistant ya completado sin mensaje idle (variantes del server).
      if (newest?.type === "assistant" && newest.time?.completed) return messages;
      if (Date.now() > deadline) {
        throw new UpstreamError(`timeout esperando respuesta del server (sesión ${sessionID})`);
      }
      await sleep(this.#completionPollMs);
    }
  }

  #mapError(error: unknown): Error {
    if (error instanceof UpstreamError || error instanceof ModelNotFoundError) return error;
    if (error instanceof OpencodeHttpError) return new UpstreamError(error.message);
    return new UpstreamError(error instanceof Error ? error.message : String(error));
  }
}
