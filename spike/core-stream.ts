/**
 * SPIKE 2 (rama spike/core-in-process): bridge como pensará fleetproxy —
 * ModelResolver del core (catálogo+auth) + @opencode/ai con request estilo
 * OpenAI (system + messages con roles) y STREAMING real.
 *
 *   FLEETPROXY_HOME=/tmp/fp-spike-home bun spike/core-stream.ts [modelo]
 */
const home = process.env.FLEETPROXY_HOME ?? `${process.env.HOME}/.fleetproxy`;
process.env.XDG_DATA_HOME = `${home}/data`;
process.env.XDG_CONFIG_HOME = `${home}/config`;
process.env.XDG_STATE_HOME = `${home}/state`;

const { Effect, Layer, Result } = await import("effect");
const { ai } = await import("@opencode/ai");
const { layer: instanceLayer } = await import("@opencode/core/instance.js");
const { Instance: InstanceService } = await import("@opencode/core/instance/service.js");
const { buildLocationServiceMap, LocationServiceMap } = await import("@opencode/core/location-services.js");
const { Model } = await import("@opencode/core/model.js");
const { ModelResolver } = await import("@opencode/core/model-resolver.js");
const { Plugin } = await import("@opencode/core/plugin.js");

// Igual que core-chat: bindings del host para los nodos unbound.
const bindings = [
  InstanceService.node.replace(
    Layer.succeed(InstanceService.Service, { provide: (effect: never) => effect } as never) as never,
  ) as never,
];
const engineLayer = instanceLayer({ directory: process.cwd() } as never, {
  replacements: [
    ...bindings,
    LocationServiceMap.node.replace(buildLocationServiceMap(bindings) as never) as never,
  ],
});

// Conversación estilo OpenAI: system aparte + historial con roles.
const SYSTEM = "Respondés en español, en una sola frase breve.";
const MESSAGES = [
  { role: "user", content: "¿Cuál es la capital de la provincia de Córdoba, Argentina?" },
  { role: "assistant", content: "Río Cuarto, me parece." },
  { role: "user", content: "¿Está bien o me corregís? Lo quiero en una frase." },
];

const program = Effect.gen(function* () {
  const plugin = yield* Plugin.Service;
  yield* plugin.awaitActivation;
  const model = yield* Model.Service;
  const models = (yield* model.available()) as readonly { id: string; providerID: string }[];
  const arg = process.argv[2] ?? "duo";
  const pick = models.find((m) => `${m.providerID}/${m.id}` === arg)
    ?? models.find((m) => `${m.providerID}/${m.id}`.toLowerCase().includes(arg.toLowerCase()));
  if (!pick) return console.log("sin modelo para", arg);
  console.log("modelo:", `${pick.providerID}/${pick.id}`);

  const resolver = yield* ModelResolver.Service;
  const resolved = yield* resolver.resolve({ id: pick.id, providerID: pick.providerID } as never) as {
    model: unknown;
  };

  const summary = yield* Effect.promise(async () => {
    const t0 = Date.now();
    let deltas = 0;
    let chars = 0;
    let first = 0;
    const seen = new Set<string>();
    let finish: any;
    const request = ai.request({ model: resolved.model as never, system: SYSTEM, messages: MESSAGES as never });
    for await (const event of ai.stream(request)) {
      seen.add(event.type);
      if (event.type === "text-delta") {
        deltas += 1;
        chars += event.text.length;
        if (first === 0) first = Date.now() - t0;
        process.stdout.write(event.text);
      } else if (event.type === "finish") {
        finish = event;
      }
    }
    return { t0, deltas, chars, first, seen: [...seen], finish };
  });
  process.stdout.write("\n");
  const usage = summary.finish?.response?.usage ?? summary.finish?.usage;
  console.log(
    `stream: ${summary.deltas} deltas / ${summary.chars} chars, primer delta ${summary.first}ms, ` +
      `total ${Date.now() - summary.t0}ms`,
  );
  console.log("eventos vistos:", summary.seen.join(", "));
  console.log("usage:", JSON.stringify(usage), "| reason:", summary.finish?.response?.finishReason ?? "?");
});

const run = await Effect.runPromise(Effect.result(program.pipe(Effect.provide(engineLayer as never))));
if (Result.isFailure(run)) {
  const err = (run as any).failure ?? run;
  console.error("ERROR:", String(err?.message ?? err).slice(0, 300));
}
