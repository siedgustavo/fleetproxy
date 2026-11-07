#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CoreBridge,
  OpencodeApiClient,
  OpencodeBridge,
  createApp,
  startEngine,
  type AuthApi,
  type Bridge,
  type Engine,
  type EngineLoginAttempt,
} from "@fleetproxy/core";
import { fleetEnv, fleetHome, isOpencodeAvailable, resolveOpencodeBin } from "@fleetproxy/fleet";

interface Config {
  port?: number;
  /** API key que exijen las rutas /v1/* (también por env FLEETPROXY_TOKEN) */
  token?: string;
  /** URL pública de la app; `login` la usa como server remoto por defecto (env FLEETPROXY_URL) */
  url?: string;
  opencode?: { url?: string };
}

const usage = `fleetproxy — façade OpenAI-compatible sobre opencode

Uso:
  fleetproxy serve [--port <n>]        Levanta el proxy (config: fleetproxy.json)
  fleetproxy models                    Lista modelos del motor conectado
  fleetproxy login <provider> [flags]  Login OAuth in-process (Integration del motor)
      --method <id>    método oauth (default: "device" si existe, si no el primero)
      --url <server>   login contra un fleetproxy corriendo (default: FLEETPROXY_URL / config "url")
      --token <t>      Bearer para ese server (default: FLEETPROXY_TOKEN / config "token")
      --timeout <s>    segundos de espera del attempt (default: 300)
      --local          fuerza motor embebido en este proceso (ignora el server)
      --no-open        no intentar abrir el navegador
      --field k=v      campo del form del método, repetible (p. ej. deploymentType=enterprise)
  fleetproxy auth [...]                auth del motor empaquetado (legacy, usa el binario)

Config (fleetproxy.json, opcional):
  { "port": 8787, "token": "sk-…", "url": "https://…",
    "opencode": { "url": "http://127.0.0.1:4096" } }
  Con "token" (o env FLEETPROXY_TOKEN) las rutas /v1/* y /auth/login* exigen
  Authorization: Bearer <token>; /health y /auth/callback quedan abiertas.
  El motor (@opencode/core) corre IN-PROCESS: sin binario, datos y logins
  aislados en ~/.fleetproxy. Con "opencode.url" se habla con un server opencode
  remoto (bridge HTTP legado, sin /auth/*).
  Providers con device flow (github-copilot) loguean desde cualquier lado; los
  de listener loopback (gitlab :8080, digitalocean :1456) loguean fácil contra
  un motor local — en remoto hace falta port-forward o pegar la URL del
  redirect en /auth/callback.
`;

function loadConfig(): Config {
  const path = join(process.cwd(), "fleetproxy.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

interface Wired {
  bridge: Bridge;
  /** motor in-process (undefined si el bridge es un server remoto por URL) */
  engine?: Engine;
  label: string;
}

/** Motor in-process con el home aislado de fleetproxy (~/.fleetproxy). */
async function startFleetEngine(): Promise<Engine> {
  const xdg = fleetEnv(fleetHome());
  return startEngine({
    xdg: { dataHome: xdg.XDG_DATA_HOME, configHome: xdg.XDG_CONFIG_HOME, stateHome: xdg.XDG_STATE_HOME },
  });
}

async function wireBridge(config: Config): Promise<Wired> {
  const remoteUrl = config.opencode?.url ?? process.env.FLEETPROXY_OPENCODE_URL;
  if (remoteUrl) {
    return {
      bridge: new OpencodeBridge(new OpencodeApiClient({ baseUrl: remoteUrl })),
      label: `server remoto ${remoteUrl}`,
    };
  }
  const engine = await startFleetEngine();
  return { bridge: new CoreBridge(engine), engine, label: `core in-process (home ${fleetHome()})` };
}

function parsePort(argv: string[], config: Config): number {
  const flag = argv.indexOf("--port");
  if (flag >= 0 && argv[flag + 1]) return Number(argv[flag + 1]);
  if (process.env.FLEETPROXY_PORT) return Number(process.env.FLEETPROXY_PORT);
  return config.port ?? 8787;
}

/** Cliente HTTP de /auth/* para loguear contra un fleetproxy remoto. */
export function loginRemoteApi(server: string, token?: string): AuthApi {
  const base = server.replace(/\/$/, "");
  const authHeaders: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const call = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...authHeaders, ...(init?.headers as Record<string, string> | undefined) },
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const hint = res.status === 401 ? " — pasá --token o FLEETPROXY_TOKEN" : "";
      throw new Error(`${json?.error?.message ?? text.slice(0, 200) ?? `HTTP ${res.status}`}${hint}`);
    }
    return json;
  };
  return {
    login: async (provider, method, answer) =>
      (await call("/auth/login", {
        method: "POST",
        body: JSON.stringify({ provider, ...(method ? { method } : {}), ...(answer ? { answer } : {}) }),
      })) as EngineLoginAttempt,
    loginStatus: async (provider, attemptID) =>
      await call(`/auth/login/${encodeURIComponent(attemptID)}?provider=${encodeURIComponent(provider)}`),
    loginComplete: async (provider, attemptID, code) => {
      await call(`/auth/login/${encodeURIComponent(attemptID)}/complete`, {
        method: "POST",
        body: JSON.stringify({ provider, ...(code !== undefined ? { code } : {}) }),
      });
    },
    loginCancel: async (provider, attemptID) => {
      await call(`/auth/login/${encodeURIComponent(attemptID)}?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
    },
  };
}

/** Espera (polling) hasta que el attempt termina; SIGINT cancela el attempt. */
export async function runLoginFlow(
  attempt: EngineLoginAttempt,
  api: Pick<AuthApi, "loginStatus" | "loginCancel">,
  opts: { timeoutMs: number; pollMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  const cancel = () => api.loginCancel(attempt.provider, attempt.attemptID).catch(() => undefined);
  const onSigint = () => {
    void cancel().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSigint);
  try {
    for (;;) {
      const status = await api.loginStatus(attempt.provider, attempt.attemptID);
      if (status.status === "complete") return;
      if (status.status === "failed") throw new Error(status.message ?? "el provider denegó la autorización");
      if (status.status === "expired") throw new Error("el attempt expiró: corré `fleetproxy login` de nuevo");
      if (Date.now() > deadline) {
        await cancel();
        throw new Error(`login sin completar en ${Math.round(opts.timeoutMs / 1000)}s (attempt cancelado)`);
      }
      await Bun.sleep(opts.pollMs);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function tryOpenBrowser(url: string): void {
  try {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const proc = Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
    proc.unref();
  } catch {
    // sin navegador: el usuario abre la URL impresa
  }
}

interface LoginFlags {
  provider: string;
  method?: string;
  url?: string;
  token?: string;
  timeoutMs: number;
  local: boolean;
  noOpen: boolean;
  /** Campos del form del método (--field clave=valor, repetible); mandan sobre los defaults. */
  fields: Record<string, string>;
}

export function parseLoginArgs(args: string[]): LoginFlags | undefined {
  const flags: Record<string, string> = {};
  const on: Record<string, true> = {};
  const positional: string[] = [];
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--local") on.local = true;
    else if (arg === "--no-open") on.noOpen = true;
    else if (arg === "--field") {
      const pair = args[(i += 1)] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg.startsWith("--")) {
      flags[arg.slice(2)] = args[i + 1] ?? "";
      i += 1;
    } else positional.push(arg);
  }
  const provider = positional[0];
  if (!provider) return undefined;
  const timeout = Number(flags.timeout ?? 300);
  return {
    provider,
    ...(flags.method ? { method: flags.method } : {}),
    ...(flags.url ? { url: flags.url } : {}),
    ...(flags.token ? { token: flags.token } : {}),
    timeoutMs: (Number.isFinite(timeout) && timeout > 0 ? timeout : 300) * 1000,
    local: on.local === true,
    noOpen: on.noOpen === true,
    fields,
  };
}

async function loginCommand(args: string[], config: Config): Promise<void> {
  const flags = parseLoginArgs(args);
  if (!flags) {
    console.error('Uso: fleetproxy login <provider> [--method <id>] [--url <server>] [--token <t>] [--timeout <s>] [--local] [--no-open]');
    console.error('     p. ej. `fleetproxy login github-copilot` (device flow) o `fleetproxy login gitlab` (loopback local)');
    process.exit(2);
  }
  const server = flags.local ? "" : flags.url ?? process.env.FLEETPROXY_URL ?? config.url ?? "";
  const token = flags.token ?? process.env.FLEETPROXY_TOKEN ?? config.token;

  let api: AuthApi;
  let engine: Engine | undefined;
  // El runtime de core loguea INFO por console.log/stdout. En modo embebido se
  // redirige a stderr durante toda la vida del motor; el CLI imprime por la
  // referencia original (stdout real). Core 2.2.6 no expone env para bajar el
  // nivel del sink de consola.
  const stdout = process.stdout;
  const realLog = console.log.bind(console);
  const fmt = (args: unknown[]) => `${args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ")}\n`;
  const cliLog = (...args: unknown[]) => stdout.write(fmt(args));
  const silence = () => {
    console.log = (...args: unknown[]) => process.stderr.write(fmt(args));
    Object.defineProperty(process, "stdout", { value: process.stderr, configurable: true, writable: true });
  };
  const unsilence = () => {
    Object.defineProperty(process, "stdout", { value: stdout, configurable: true, writable: true });
    console.log = realLog;
  };
  if (server) {
    api = loginRemoteApi(server, token);
    cliLog(`login contra ${server} (${flags.provider})`);
  } else {
    silence();
    try {
      engine = await startFleetEngine();
    } catch (error) {
      unsilence();
      throw error;
    }
    api = engine;
    cliLog(`login embebido, home ${fleetHome()} (${flags.provider})`);
  }

  try {
    const attempt = await api.login(flags.provider, flags.method, Object.keys(flags.fields).length > 0 ? flags.fields : undefined);
    if (attempt.url) cliLog(`  Abrí en el navegador: ${attempt.url}`);
    if (attempt.instructions) cliLog(`  ${attempt.instructions}`);
    const applied = Object.entries(attempt.answer ?? {});
    if (applied.length > 0) cliLog(`  form: ${applied.map(([k, v]) => `${k}=${v}`).join(" ")} (con --field lo cambiás)`);
    if (attempt.url && !flags.noOpen && process.stdout.isTTY) tryOpenBrowser(attempt.url);
    cliLog("  esperando autorización…");
    await runLoginFlow(attempt, api, { timeoutMs: flags.timeoutMs, pollMs: 1500 });
    cliLog(`✓ ${flags.provider} autenticado (credencial guardada en ${fleetHome()})`);
  } finally {
    await engine?.close();
    if (!server) unsilence();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";
  const config = loadConfig();

  if (command === "serve") {
    const port = parsePort(argv, config);
    const { bridge, engine, label } = await wireBridge(config);
    // El login OAuth vive en el motor in-process; con bridge remoto no hay /auth/*.
    const app = createApp({ bridge, apiToken: process.env.FLEETPROXY_TOKEN ?? config.token, auth: engine });
    const server = Bun.serve({ port, fetch: app.fetch });
    const models = await bridge.catalog().catch(() => []);
    console.log(`fleetproxy escuchando en http://localhost:${server.port}`);
    console.log(`  opencode: ${label}`);
    console.log(`  modelos:  ${models.length}`);
    // desmontaje limpio del motor in-process (el runtime deja watchers/DB abiertos)
    if (engine) {
      const bye = () => {
        engine.close().finally(() => process.exit(0));
      };
      process.on("SIGTERM", bye);
      process.on("SIGINT", bye);
    }
    return;
  }

  if (command === "models") {
    const { bridge, engine } = await wireBridge(config);
    const models = await bridge.catalog();
    for (const model of models) console.log(model.id);
    if (models.length === 0) console.log("(sin modelos: corré `fleetproxy login` para autenticar un provider)");
    await engine?.close();
    return;
  }

  if (command === "login") {
    await loginCommand(argv.slice(1), config);
    return;
  }

  if (command === "auth") {
    // Legacy: auth del binario empaquetado (list/logout del storage compartido).
    const bin = resolveOpencodeBin();
    if (!bin || !isOpencodeAvailable(bin)) {
      console.error("fleetproxy: motor opencode (binario) no disponible para `auth`; `fleetproxy login` no lo necesita.");
      process.exit(1);
    }
    const home = fleetHome();
    for (const dir of Object.values(fleetEnv(home))) mkdirSync(dir, { recursive: true });
    const proc = Bun.spawn([bin, "auth", ...argv.slice(1)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ...fleetEnv(home) } as Record<string, string>,
    });
    const code = await proc.exited;
    if (code !== 0) process.exit(code ?? 1);
    return;
  }

  console.log(usage);
}

// El módulo se puede importar en tests sin ejecutar el comando.
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`fleetproxy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
