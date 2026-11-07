/**
 * Motor in-process: @opencode/core corriendo dentro de fleetproxy, sin el
 * binario `opencode serve`. Levanta las layers Effect del runtime (providers,
 * credenciales, catálogo models.dev) y expone la superficie mínima que el
 * bridge necesita: models / ask / close.
 *
 * Aislamiento: el home se fija por XDG_* ANTES de importar core (lee el env al
 * importarse); `startEngine` recibe las dirs que calcula @fleetproxy/fleet.
 *
 * Dos cosas que hay que saber de este runtime (medidas en el spike, nov/2026):
 *   - los providers built-in son PLUGINS INTERNOS que registra Plugin.Service:
 *     hay que esperar `awaitActivation` antes de leer el catálogo (si no, es 0)
 *   - el graph de Instance deja dos nodos unbound que el host liga afuera:
 *     Instance.Service (capacidades de sesión; el chat no lo usa → stub) y
 *     LocationServiceMap (helper oficial buildLocationServiceMap)
 */
import { ModelNotFoundError, UpstreamError, type ChatResult } from "./bridge";

export interface EngineTurn {
  role: "user" | "assistant";
  text: string;
}

export interface EngineAskParams {
  providerID: string;
  modelID: string;
  /** system "de verdad" del request OpenAI (va aparte, no mezclado en el prompt) */
  system?: string;
  turns: EngineTurn[];
}

export interface EngineModelInfo {
  providerID: string;
  modelID: string;
  name?: string;
  contextWindow?: number;
}

/** Attempt de login devuelto por Integration.oauth.connect (url + código/instrucciones). */
export interface EngineLoginAttempt {
  provider: string;
  method: string;
  attemptID: string;
  url: string;
  instructions: string;
  /** "auto": el propio core resuelve el attempt (polling device / listener loopback). */
  mode: "auto" | "code";
  /** Respuesta efectiva al form del método (defaults aplicados + lo que pasó el cliente). */
  answer: Record<string, string>;
}

export type EngineLoginStatus =
  | { status: "pending" }
  | { status: "complete" }
  | { status: "failed"; message?: string }
  | { status: "expired" };

export type LoginErrorKind =
  | "provider-not-found"
  | "no-oauth-method"
  | "form-required"
  | "attempt-not-found"
  | "code-required"
  | "authorization-failed";

export class LoginError extends Error {
  constructor(
    readonly kind: LoginErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

export interface Engine {
  models(): Promise<EngineModelInfo[]>;
  /**
   * Corre 1 solo modelo (sin agent loop ni tools) y devuelve texto + usage.
   * `onDelta` recibe cada fragmento de texto en vivo (para el SSE del façade).
   */
  ask(params: EngineAskParams, onDelta?: (delta: string) => void): Promise<ChatResult>;
  /**
   * Inicia un attempt de OAuth vía Integration.Service. Sin `methodID` se elige
   * el método "device" si existe (Copilot), si no el primer método oauth. Los
   * campos requeridos del form del método se autocompletan con su primera
   * option si hace falta; `answer` (del cliente) manda sobre los defaults.
   */
  login(provider: string, methodID?: string, answer?: Record<string, string>): Promise<EngineLoginAttempt>;
  loginStatus(provider: string, attemptID: string): Promise<EngineLoginStatus>;
  /** Completa un attempt mode "code" (o auto con paste) usando el code/URL del redirect. */
  loginComplete(provider: string, attemptID: string, code?: string): Promise<void>;
  loginCancel(provider: string, attemptID: string): Promise<void>;
  close(): Promise<void>;
}

export interface EngineOptions {
  /** XDG del home fleetproxy (lo calcula fleetEnv()); se asignan al process antes de importar core. */
  xdg?: { dataHome?: string; configHome?: string; stateHome?: string };
  /** Directorio-workspace que abre core (descubrimiento de config/proyecto); default cwd. */
  directory?: string;
}

export async function startEngine(options: EngineOptions = {}): Promise<Engine> {
  if (options.xdg?.dataHome) process.env.XDG_DATA_HOME = options.xdg.dataHome;
  if (options.xdg?.configHome) process.env.XDG_CONFIG_HOME = options.xdg.configHome;
  if (options.xdg?.stateHome) process.env.XDG_STATE_HOME = options.xdg.stateHome;
  process.env.OPENCODE_LOG_LEVEL ??= "WARN";

  const [{ Effect, Layer, ManagedRuntime }, { ai }, { LayerNode }, nodeUtilMod, instanceMod, serviceMod, locMod, locationMod, dbMod, credMod, appMod, modelMod, resolverMod, pluginMod, integrationMod] =
    await Promise.all([
      import("effect"),
      import("@opencode/ai"),
      import("@opencode/util/effect/layer-node"),
      import("@opencode/util/effect/app-node"),
      import("@opencode/core/instance"),
      import("@opencode/core/instance/service"),
      import("@opencode/core/location-services"),
      import("@opencode/core/location"),
      import("@opencode/core/database/database"),
      import("@opencode/core/credential"),
      import("@opencode/core/app"),
      import("@opencode/core/model"),
      import("@opencode/core/model-resolver"),
      import("@opencode/core/plugin"),
      import("@opencode/core/integration"),
    ]);

  const directory = options.directory ?? process.cwd();
  const bindings = [
    serviceMod.Instance.node.replace(
      Layer.succeed(serviceMod.Instance.Service, { provide: (effect: never) => effect } as never) as never,
    ) as never,
  ];
  // El graph de Instance NO trae los nodos "global" que la app CLI sí enlaza:
  // Credential (credenciales OAuth del db) y App. Además su Database por defecto
  // es :memory: → hay que reemplazarlo por el archivo del home (opencode.db,
  // relativo a Global.data = $XDG_DATA_HOME/opencode) o ninguna credenciales
  // (p. ej. GitHub Copilot) aparece como conectada. El nodo Location va ligado
  // al directorio (boundNode), igual que hacía Instance.layer por dentro.
  const dbNamespace = (dbMod as Record<string, any>).Database ?? dbMod;
  const engineLayer = LayerNode.compile(
    LayerNode.group([instanceMod.graph, credMod.Credential.node, appMod.App.node] as never),
    {
      replacements: [
        ...bindings,
        locMod.LocationServiceMap.node.replace(locMod.buildLocationServiceMap(bindings) as never) as never,
        locationMod.node.replace(locationMod.boundNode({ directory } as never) as never) as never,
        dbNamespace.node.replace(dbNamespace.configured({ path: "opencode.db" })) as never,
      ],
      shared: (nodeUtilMod as any).Node.tags.values.global,
    },
  ) as never;
  const runtime = ManagedRuntime.make(engineLayer);
  const run = <T>(effect: unknown): Promise<T> => runtime.runPromise(effect as never) as Promise<T>;

  await run<unknown>(
    Effect.gen(function* () {
      const plugins = yield* pluginMod.Plugin.Service;
      yield* plugins.awaitActivation;
    }),
  );

  async function models(): Promise<EngineModelInfo[]> {
    const infos = await run<readonly Record<string, unknown>[]>(
      Effect.gen(function* () {
        const model = yield* modelMod.Model.Service;
        return yield* model.available();
      }),
    );
    return infos
      .map((m) => {
        const providerID = String(m.providerID ?? "");
        const modelID = String(m.modelID ?? m.id ?? "");
        const limit = m.limit as { context?: number } | undefined;
        return {
          providerID,
          modelID,
          name: typeof m.name === "string" ? m.name : undefined,
          contextWindow: typeof limit?.context === "number" ? limit.context : undefined,
        };
      })
      .filter((m) => m.providerID && m.modelID);
  }

  async function ask(params: EngineAskParams, onDelta?: (delta: string) => void): Promise<ChatResult> {
    const resolved = await run<{ model: unknown } | undefined>(
      Effect.gen(function* () {
        const resolver = yield* resolverMod.ModelResolver.Service;
        return yield* resolver.resolve({ id: params.modelID, providerID: params.providerID } as never);
      }),
    );
    if (!resolved) throw new ModelNotFoundError(`${params.providerID}/${params.modelID}`);

    const request = ai.request({
      model: resolved.model as never,
      ...(params.system ? { system: params.system } : {}),
      // @opencode/ai espera {role, content}; nuestro EngineTurn usa {role, text}
      messages: params.turns.map((t) => ({ role: t.role, content: t.text })) as never,
    });
    let text = "";
    let usage = { input: 0, output: 0, total: 0 };
    try {
      for await (const event of ai.stream(request) as AsyncIterable<Record<string, any>>) {
        if (event.type === "text-delta") {
          const delta = String(event.text ?? "");
          text += delta;
          onDelta?.(delta);
        } else if (event.type === "finish") {
          const u = event.response?.usage ?? event.usage;
          if (u) {
            usage = {
              input: u.inputTokens ?? 0,
              output: u.outputTokens ?? 0,
              total: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            };
          }
        }
      }
    } catch (error) {
      throw new UpstreamError(error instanceof Error ? error.message : String(error));
    }
    if (!text) throw new UpstreamError(`el proveedor no devolvió texto (${params.providerID}/${params.modelID})`);
    return { text, usage };
  }

  /** Los errores del Integration service son TaggedError (llevan `_tag`); los mapeamos a LoginError. */
  function toLoginError(error: unknown, provider: string): unknown {
    const tag = (error as { _tag?: string } | undefined)?._tag;
    const message = error instanceof Error ? error.message : String(error);
    if (tag === "Integration.AttemptNotFound") return new LoginError("attempt-not-found", message);
    if (tag === "Integration.CodeRequired") return new LoginError("code-required", "el método requiere el `code` del redirect (pegalo del navegador)");
    if (tag === "Integration.Authorization") return new LoginError("authorization-failed", message);
    if (/method not found/i.test(message)) return new LoginError("no-oauth-method", `el provider ${provider} no ofrece ese método oauth`);
    return error;
  }

  // fx devuelve un Effect (el tipo Effect no está en scope: el módulo se importa dinámicamente).
  const withIntegration = <T>(fx: (integration: any) => unknown): Promise<T> =>
    run<T>(
      Effect.gen(function* () {
        const integration = yield* (integrationMod as any).Integration.Service;
        return (yield* (fx(integration) as any)) as T;
      }),
    );

  interface FormField {
    key?: unknown;
    required?: unknown;
    options?: unknown;
    when?: unknown;
  }

  /**
   * Resuelve el form del método: los requeridos con options toman su primera
   * opción (p. ej. deploymentType=github.com); si falta alguno sin default,
   * LoginError form-required con la lista de claves.
   */
  function resolveAnswer(fields: FormField[], answer: Record<string, string>): { ok: true; answer: Record<string, string> } | { ok: false; missing: string[] } {
    const out = { ...answer };
    const missing: string[] = [];
    for (const field of fields) {
      if (field?.required !== true) continue;
      const key = String(field.key ?? "");
      if (!key) continue;
      // `when: [{key, op:"eq", value}]`: el campo solo aplica si el answer ya eligió ese valor.
      const conditions = Array.isArray(field.when) ? (field.when as { key?: unknown; op?: unknown; value?: unknown }[]) : [];
      const applies = conditions.every((w) => (w?.op === "eq" ? out[String(w.key)] === w.value : true));
      if (!applies) continue;
      if (out[key] !== undefined && out[key] !== "") continue;
      const options = Array.isArray(field.options) ? (field.options as { value?: unknown }[]) : [];
      if (options.length > 0) {
        out[key] = String(options[0]?.value ?? "");
        continue;
      }
      missing.push(key);
    }
    return missing.length > 0 ? { ok: false, missing } : { ok: true, answer: out };
  }

  async function login(provider: string, methodID?: string, answer?: Record<string, string>): Promise<EngineLoginAttempt> {
    const info = await withIntegration<{ id: string; methods: { id: string; type: string; form?: FormField[] }[] } | undefined>(
      (integration) => integration.get(provider as never),
    ).catch((error) => {
      throw toLoginError(error, provider);
    });
    if (!info) throw new LoginError("provider-not-found", `provider desconocido para login: ${provider}`);
    const oauthMethods = (info.methods ?? []).filter((m) => m.type === "oauth");
    const chosen = methodID
      ? oauthMethods.find((m) => m.id === methodID)
      : oauthMethods.find((m) => m.id === "device") ?? oauthMethods[0];
    if (!chosen) {
      const available = oauthMethods.map((m) => m.id).join(", ") || "ninguno";
      throw new LoginError(
        "no-oauth-method",
        `${provider} no tiene método oauth "${methodID ?? "device"}" (disponibles: ${available})`,
      );
    }
    const resolved = resolveAnswer(chosen.form ?? [], answer ?? {});
    if (!resolved.ok) {
      throw new LoginError(
        "form-required",
        `faltan campos del formulario de ${provider}: ${resolved.missing.join(", ")} (pasalos con answer/--field)`,
      );
    }
    const attempt = await withIntegration<Record<string, any>>((integration) =>
      integration.oauth.connect({ integrationID: provider as never, methodID: chosen.id as never, answer: resolved.answer as never }),
    ).catch((error) => {
      throw toLoginError(error, provider);
    });
    return {
      provider,
      method: chosen.id,
      attemptID: String(attempt.attemptID),
      url: typeof attempt.url === "string" ? attempt.url : "",
      instructions: typeof attempt.instructions === "string" ? attempt.instructions : "",
      mode: attempt.mode === "code" ? "code" : "auto",
      answer: resolved.answer,
    };
  }

  async function loginStatus(provider: string, attemptID: string): Promise<EngineLoginStatus> {
    const status = await withIntegration<Record<string, any>>((integration) =>
      integration.oauth.status({ integrationID: provider as never, attemptID: attemptID as never }),
    ).catch((error) => {
      throw toLoginError(error, provider);
    });
    if (status?.status === "failed") return { status: "failed", message: typeof status.message === "string" ? status.message : undefined };
    if (status?.status === "complete") return { status: "complete" };
    if (status?.status === "expired") return { status: "expired" };
    return { status: "pending" };
  }

  async function loginComplete(provider: string, attemptID: string, code?: string): Promise<void> {
    await withIntegration((integration) =>
      integration.oauth.complete({ integrationID: provider as never, attemptID: attemptID as never, ...(code !== undefined ? { code } : {}) }),
    ).catch((error) => {
      throw toLoginError(error, provider);
    });
  }

  async function loginCancel(provider: string, attemptID: string): Promise<void> {
    await withIntegration((integration) =>
      integration.oauth.cancel({ integrationID: provider as never, attemptID: attemptID as never }),
    ).catch((error) => {
      throw toLoginError(error, provider);
    });
  }

  return {
    models,
    ask,
    login,
    loginStatus,
    loginComplete,
    loginCancel,
    close: async () => {
      await runtime.dispose().catch(() => undefined);
    },
  };
}
