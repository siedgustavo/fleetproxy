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

export interface Engine {
  models(): Promise<EngineModelInfo[]>;
  /**
   * Corre 1 solo modelo (sin agent loop ni tools) y devuelve texto + usage.
   * `onDelta` recibe cada fragmento de texto en vivo (para el SSE del façade).
   */
  ask(params: EngineAskParams, onDelta?: (delta: string) => void): Promise<ChatResult>;
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

  const [{ Effect, Layer, ManagedRuntime }, { ai }, { layer: instanceLayer }, serviceMod, locMod, modelMod, resolverMod, pluginMod] =
    await Promise.all([
      import("effect"),
      import("@opencode/ai"),
      import("@opencode/core/instance"),
      import("@opencode/core/instance/service"),
      import("@opencode/core/location-services"),
      import("@opencode/core/model"),
      import("@opencode/core/model-resolver"),
      import("@opencode/core/plugin"),
    ]);

  const bindings = [
    serviceMod.Instance.node.replace(
      Layer.succeed(serviceMod.Instance.Service, { provide: (effect: never) => effect } as never) as never,
    ) as never,
  ];
  const engineLayer = instanceLayer({ directory: options.directory ?? process.cwd() } as never, {
    replacements: [
      ...bindings,
      locMod.LocationServiceMap.node.replace(locMod.buildLocationServiceMap(bindings) as never) as never,
    ],
  }) as never;
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

  return {
    models,
    ask,
    close: async () => {
      await runtime.dispose().catch(() => undefined);
    },
  };
}
