export interface OpencodeApiClientConfig {
  baseUrl: string;
  /** password del server (Basic auth con usuario "opencode"); undefined = sin auth */
  password?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class OpencodeHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpencodeHttpError";
  }
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Cliente HTTP mínimo contra la API v2 del server de opencode (rutas /api/*).
 * Preferimos esto al client generado del SDK porque el generado (sdk 1.19.5)
 * driftó del server real (opencode 2.2.x): prompt espera body plano,
 * y /wait no existe. Rutas verificadas contra opencode 2.2.4:
 *
 *   GET  /api/provider                       → { data: [{ id, ... }] }
 *   GET  /api/model                          → { data: [{ id, providerID, name, ... }] }
 *   POST /api/session                        → { data: { id, ... } }
 *   POST /api/session/{id}/prompt {text}     → { data: { id } }   (admite el turno)
 *   GET  /api/session/{id}/message           → { data: [ {... newest-first} ] }  (type "idle" marca fin de turno)
 *   GET  /api/session/{id}                   → { data: { id, tokens: {input,output,...} } }
 */
export class OpencodeApiClient {
  #config: Required<Pick<OpencodeApiClientConfig, "baseUrl" | "requestTimeoutMs">> & OpencodeApiClientConfig;
  #fetch: typeof fetch;

  constructor(config: OpencodeApiClientConfig) {
    this.#config = { requestTimeoutMs: 60_000, ...config, baseUrl: config.baseUrl.replace(/\/$/, "") };
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
  }

  get baseUrl(): string {
    return this.#config.baseUrl;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#config.password) headers.Authorization = `Basic ${base64(`opencode:${this.#config.password}`)}`;
    const response = await this.#fetch(`${this.#config.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!response.ok) {
      throw new OpencodeHttpError(response.status, `${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
