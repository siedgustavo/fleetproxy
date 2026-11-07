// Sonda de diagnóstico: ¿por qué el core in-process no ve github-copilot?
// Ejecutar con los XDG_* ya apuntando al home de fleetproxy, desde packages/core/.
const [{ Effect }, { layer: il }, { Instance: Is }, { buildLocationServiceMap, LocationServiceMap }, modelMod, pluginMod, providerMod, appMod, integrationMod, credentialMod, envMod] =
  await Promise.all([
    import("effect"),
    import("@opencode/core/instance"),
    import("@opencode/core/instance/service"),
    import("@opencode/core/location-services"),
    import("@opencode/core/model"),
    import("@opencode/core/plugin"),
    import("@opencode/core/provider"),
    import("@opencode/core/app"),
    import("@opencode/core/integration"),
    import("@opencode/core/credential"),
    import("@opencode/core/environment/environment"),
  ]);
const { Layer } = await import("effect");
const { LayerNode } = await import("@opencode/util/effect/layer-node");
const NodeUtil = await import("@opencode/util/effect/app-node");
const instanceMod = await import("@opencode/core/instance");
const dbMod = await import("@opencode/core/database/database");
const bindings = [Is.node.replace(Layer.succeed(Is.Service, { provide: (e: never) => e } as never) as never) as never];
const replacements = [
  ...bindings,
  LocationServiceMap.node.replace(buildLocationServiceMap(bindings) as never) as never,
];
const lay = process.env.FP_BIND_GLOBAL_NODES
  ? (LayerNode.compile(
      LayerNode.group([instanceMod.graph, credentialMod.Credential.node, appMod.App.node] as never),
      {
        replacements: [
          ...replacements,
          (await import("@opencode/core/location")).node.replace(
            (await import("@opencode/core/location")).boundNode({ directory: process.cwd() } as never) as never,
          ) as never,
          ...(() => {
            const DB = (dbMod as any).Database ?? dbMod;
            return [DB.node.replace(DB.configured({ path: "opencode.db" })) as never];
          })(),
        ],
        shared: NodeUtil.Node.tags.values.global,
      },
    ) as never)
  : il({ directory: process.cwd() } as never, { replacements });
await Effect.runPromise(
  Effect.gen(function* () {
    const p = yield* pluginMod.Plugin.Service;
    yield* p.awaitActivation;
    try {
      const infos = yield* p.list();
      const failed = infos.filter((x: any) => x?.state?.status === "failed" || x?.status === "failed");
      console.log("plugins:", infos.length, "| fallidos:", failed.map((x: any) => x.id).join(",") || "ninguno");
      for (const x of infos) if (/copilot|gitlab|digitalocean|chatgpt/.test(String(x.id)))
        console.log(" plugin:", x.id, "→", JSON.stringify(x.state ?? x.status ?? "?").slice(0, 160));
    } catch (e) {
      console.log("Plugin.list err:", String(e).slice(0, 200));
    }
    const m = yield* modelMod.Model.Service;
    const ms = yield* m.available();
    const byProv: Record<string, number> = {};
    for (const x of ms) byProv[String(x.providerID)] = (byProv[String(x.providerID)] ?? 0) + 1;
    console.log("available por provider:", JSON.stringify(byProv));
    try {
      const prov = yield* providerMod.Provider.Service;
      for (const fn of ["all", "list", "snapshot", "connected"] as const) {
        const f = (prov as any)[fn];
        if (typeof f !== "function") continue;
        try {
          const r = yield* (f.call(prov) as any);
          const arr = Array.isArray(r) ? r : (r?.providers ?? r?.all ?? r?.value ?? []);
          const ids = (Array.isArray(arr) ? arr : []).map((x: any) => String(x.id ?? x.providerID ?? x)).slice(0, 40);
          console.log(`provider.${fn}:`, ids.join(",") || JSON.stringify(r)?.slice(0, 300));
        } catch (e) {
          console.log(`provider.${fn} err:`, String(e).slice(0, 160));
        }
      }
    } catch (e) {
      console.log("Provider.Service no disponible:", String(e).slice(0, 160));
    }
    try {
      const integ = yield* integrationMod.Integration.Service;
      const cop = yield* (integ as any).connection.active("github-copilot");
      console.log("connection.active(github-copilot):", JSON.stringify(cop));
      const gl = yield* (integ as any).connection.active("gitlab");
      console.log("connection.active(gitlab):", JSON.stringify(gl));
      const listFn = (integ as any).list ?? (integ as any).all;
      const credAttempt = yield* Effect.exit(
        Effect.gen(function* () {
          const credSvc = yield* credentialMod.Credential.Service;
          const { Database } = yield* Effect.promise(() => import("bun:sqlite"));
          const file = process.env.FP_DB ?? "/tmp/fp-probe-none.db";
          const rawIds = new Database(file, { readonly: true }).query("select id from credential").all().map((r) => r.id);
          const all = yield* (credSvc as any).all();
          const one = rawIds[0] ? yield* (credSvc as any).get(rawIds[0]) : undefined;
          const envOut = yield* Effect.exit(
            Effect.gen(function* () {
              const envSvc = yield* envMod.Environment.Service;
              const paths: Record<string, unknown> = {};
              for (const k of Object.keys(envSvc)) {
                const v = (envSvc as any)[k];
                if (typeof v === "string") paths[k] = v;
              }
              return JSON.stringify(paths).slice(0, 500);
            }),
          );
          return { onDisk: rawIds.length, all: all.length, get: one ? `${one.id}/${one.value?.type}` : "undefined", env: envOut._tag === "Success" ? envOut.value : "sin Environment.Service" };
        }),
      );
      console.log(
        "Credential.list(github-copilot):",
        credAttempt._tag === "Success"
          ? JSON.stringify(credAttempt.value)
          : "FALLÓ: " + ((credAttempt as any).cause?.reasons ?? [(credAttempt as any).cause]).map((r: any) => String(r.defect ?? r.failure ?? r)).join(" | ").slice(0, 300),
      );
      // ¿la DB del servicio es la del archivo o es otra (:memory:)? crear y recontar en disco
      const createProbe = yield* Effect.exit(
        Effect.gen(function* () {
          const credSvc = yield* credentialMod.Credential.Service;
          const { Database } = yield* Effect.promise(() => import("bun:sqlite"));
          const file = process.env.FP_DB!;
          const before = new Database(file, { readonly: true }).query("select count(*) c from credential").get() as { c: number };
          const created = yield* (credSvc as any).create({ integrationID: "fp-probe", value: { type: "key", key: "probe" }, activate: true });
          const allAfter = yield* (credSvc as any).all();
          const after = new Database(file, { readonly: true }).query("select count(*) c from credential").get() as { c: number };
          return { fileBefore: before.c, svcAllAfter: allAfter.length, fileAfter: after.c, created: created?.id };
        }),
      );
      console.log("Probe create:", createProbe._tag === "Success" ? JSON.stringify(createProbe.value) : "FALLÓ " + String((createProbe as any).cause).slice(0, 150));
      if (listFn) {
        const ints = yield* listFn.call(integ);
        const arr = Array.isArray(ints) ? ints : Array.from(ints ?? []);
        const one = arr.find((x: any) => String(x.id) === "github-copilot");
        console.log("integraciones:", arr.length, "| copilot:", one ? JSON.stringify({ methods: (one.methods ?? []).map((m: any) => m.id ?? m.type), conns: (one.connections ?? []).length }) : "NO ESTÁ EN EL CATÁLOGO");
      }
    } catch (e) {
      console.log("Integration err:", String(e).slice(0, 240));
    }
    try {
      const app = yield* appMod.App.Service;
      const info = (app as any).info ?? (app as any).current ?? (app as any).get;
      const r = typeof info === "function" ? yield* info.call(app) : info;
      console.log("App.Info:", JSON.stringify(r)?.slice(0, 300) ?? String(r));
    } catch (e) {
      console.log("App.Service no disponible:", String(e).slice(0, 200));
    }
  }).pipe(Effect.provide(lay as never)),
);
process.exit(0);
