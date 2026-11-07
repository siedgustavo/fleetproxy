/**
 * SPIKE (rama spike/core-in-process): arrancar @opencode/core IN-PROCESS sin el
 * binario `opencode serve`. Composición con Instance.layer (graph completo) pero
 * el programa solo pide Model + Generate → Effect construye perezosamente esa
 * porción (MCP/PTY/watcher no deberían adquirirse).
 *
 * Corre con el home de fleetproxy (~/.fleetproxy, ya tiene login de Copilot):
 *   FLEETPROXY_HOME=~/.fleetproxy bun spike/core-chat.ts
 */
const home = process.env.FLEETPROXY_HOME ?? `${process.env.HOME}/.fleetproxy`;
process.env.XDG_DATA_HOME = `${home}/data`;
process.env.XDG_CONFIG_HOME = `${home}/config`;
process.env.XDG_STATE_HOME = `${home}/state`;

const { Effect, Layer, Result } = await import("effect");
const { layer: instanceLayer } = await import("@opencode/core/instance.js");
const { Instance: InstanceService } = await import("@opencode/core/instance/service.js");
const { buildLocationServiceMap, LocationServiceMap } = await import("@opencode/core/location-services.js");
const { Model } = await import("@opencode/core/model.js");
const { Provider } = await import("@opencode/core/provider.js");

const { Integration } = await import("@opencode/core/integration.js");
const { Plugin } = await import("@opencode/core/plugin.js");
const { Generate } = await import("@opencode/core/generate.js");

const rss = (label: string) =>
  console.log(`[mem] ${label}: ${(process.memoryUsage.rss() / 1048576).toFixed(0)} Mi`);
rss("post-import");

// Location.Ref = { directory: AbsolutePath, workspaceID? } — brand sin validación runtime acá.
// El graph de Instance deja dos nodos unbound que el host (TUI/server) liga afuera:
// Instance.Service (capacidades de sesión; nada del chat lo pide → stub) y
// LocationServiceMap (mapa de graphs por ubicación; se liga con el helper oficial).
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

type ModelInfo = { id: string; providerID: string; title?: string; cost?: unknown };

const program = Effect.gen(function* () {
  // Los providers built-in son plugins internos: hay que esperar la activación.
  const plugin = yield* Plugin.Service;
  yield* plugin.awaitActivation;
  const integration = yield* Integration.Service;
  const ints = yield* integration.list();
  const connected = ints.filter((i: any) => (i.connections?.length ?? 0) > 0 || i.connection);
  console.log(`integraciones: ${ints.length} | conectadas:`, connected.map((i: any) => i.id).join(",") || "(ninguna)");
  const provider = yield* Provider.Service;
  const pAll = yield* provider.all();
  const pAvail = yield* provider.available();
  console.log(
    `providers: all=${pAll.length} available=${pAvail.length}`,
    "|",
    pAvail.slice(0, 8).map((p: any) => p.id ?? p.providerID).join(","),
  );
  const model = yield* Model.Service;
  const all = (yield* model.all()) as readonly ModelInfo[];
  const models = (yield* model.available()) as readonly ModelInfo[];
  rss("post-catalog");
  console.log(`modelos: all=${all.length} available=${models.length}`);
  // argv: [modelo] [prompt...] — modelo puede ser "provider/id" exacto o substring (gitlab, copilot, duo…).
  const [modelArg, ...promptRest] = process.argv.slice(2);
  const promptText = promptRest.length ? promptRest.join(" ") : "Responde exactamente: OK";
  const matches = (m: ModelInfo) => {
    const full = `${m.providerID}/${m.id}`;
    return !modelArg || full === modelArg || full.toLowerCase().includes(modelArg.toLowerCase());
  };
  const priority = ["github-copilot", "gitlab", "chatgpt", "openai", "opencode"];
  const rank = (m: ModelInfo) => priority.findIndex((p) => String(m.providerID).includes(p));
  const sorted = models.filter(matches).sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)].map((r) => (r < 0 ? 99 : r));
    return ra - rb;
  });
  if (modelArg && sorted.length === 0) {
    console.log(`sin matches para "${modelArg}"; disponibles:`, models.slice(0, 20).map((m) => `${m.providerID}/${m.id}`).join(", "));
    return;
  }
  const pick = sorted[0];
  if (!pick) return console.log("sin modelos: credenciales/catálogo no resueltos");
  const gen = yield* Generate.Service;
  const t0 = Date.now();
  const result = yield* Effect.result(
    gen.text({ prompt: promptText, model: { id: pick.id, providerID: pick.providerID } as never }),
  );
  rss("post-generate");
  if (Result.isFailure(result)) {
    const err = (result as any).failure ?? result;
    console.log(
      `generate (${pick.providerID}/${pick.id}) falló en ${Date.now() - t0}ms →`,
      err?.reason ?? "",
      String(err?.message ?? err).slice(0, 160),
    );
  } else {
    console.log(`generate (${pick.providerID}/${pick.id}) en ${Date.now() - t0}ms →`, JSON.stringify(result.success).slice(0, 120));
  }
});

await Effect.runPromise(program.pipe(Effect.provide(engineLayer as never)));
rss("fin");
