import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Un miembro de la flota es una instancia de `opencode serve` accesible por HTTP.
 * flota = N instancias (cada una con su perfil/credenciales) o instancias
 * remotas ya corriendo a las que nos attachemos.
 */
export interface FleetMember {
  id: string;
  url: string;
  /** password del server (Basic auth); undefined = sin auth */
  password?: string;
  /** home de la instancia (~/.fleetproxy en spawn; "attach" para servers remotos) */
  profile: string;
  spawned: boolean;
  close(): Promise<void> | void;
}

let memberSeq = 0;
const nextId = () => `member-${(memberSeq += 1)}`;

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

/** Miembro que ya está corriendo en otra parte (attach). */
export function memberFromUrl(url: string, password?: string): FleetMember {
  return {
    id: nextId(),
    url: url.replace(/\/$/, ""),
    password: password ?? process.env.FLEETPROXY_OPENCODE_PASSWORD,
    profile: "attach",
    spawned: false,
    close: () => {},
  };
}

/**
 * Casa de fleetproxy: data, logins y configuración del motor viven acá,
 * aislados del opencode del sistema (que para nosotros es solo un engine).
 */
export function fleetHome(): string {
  return join(homedir(), ".fleetproxy");
}

/** Variables XDG que aíslan al motor dentro de `home`. */
export function fleetEnv(home = fleetHome()): Record<string, string> {
  return {
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
  };
}

/**
 * Binario del motor: la dependencia `opencode-ai` (npm) empaqueta un binario
 * por plataforma. Nunca usamos el opencode del sistema.
 */
export function bundledOpencodeBin(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("opencode-ai/package.json");
    const pkg = require(pkgPath) as { bin?: string | Record<string, string> };
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.opencode;
    if (!binRel) return undefined;
    const bin = join(dirname(pkgPath), binRel);
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

/** Binario del motor a usar (override interno para tests; si no, el empaquetado). */
export function resolveOpencodeBin(preferred?: string): string | undefined {
  return preferred ?? bundledOpencodeBin();
}

export function isOpencodeAvailable(bin: string): boolean {
  return bin.includes("/") ? existsSync(bin) : Bun.which(bin) !== null;
}

function engineMissingError(bin?: string): Error {
  return new Error(
    `El motor opencode de fleetproxy no está disponible${bin ? ` (${bin})` : ""}.\n` +
      "  - Reinstalá las dependencias de fleetproxy (el paquete `opencode-ai` trae el binario).\n" +
      '  - O adjuntá un server existente: { "opencode": { "url": "http://..." } } en fleetproxy.json.',
  );
}

/**
 * Spawnea el `opencode serve` empaquetado con:
 *   - home aislado (~/.fleetproxy): ni data, ni auth, ni config compartidos con el sistema
 *   - password conocida (OPENCODE_SERVER_PASSWORD) para el Basic auth interno
 * parseamos el stdout nosotros mismos porque el formato cambió entre versiones.
 */
export async function spawnMember(
  options: { port?: number; home?: string; timeoutMs?: number; bin?: string } = {},
): Promise<FleetMember> {
  const bin = resolveOpencodeBin(options.bin);
  if (!bin || !isOpencodeAvailable(bin)) throw engineMissingError(bin);

  const home = options.home ?? fleetHome();
  const env = {
    ...(process.env as Record<string, string>),
    ...fleetEnv(home),
    OPENCODE_SERVER_PASSWORD: `fleet-${crypto.randomUUID()}`,
  };
  for (const dir of Object.values(fleetEnv(home))) mkdirSync(dir, { recursive: true });

  const port = options.port ?? 18_000 + Math.floor(Math.random() * 4_000);
  const proc = Bun.spawn([bin, "serve", "--hostname=127.0.0.1", `--port=${port}`], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const url = await waitForListeningUrl(proc, options.timeoutMs ?? 60_000);

  return {
    id: nextId(),
    url,
    password: env.OPENCODE_SERVER_PASSWORD,
    profile: home,
    spawned: true,
    close: async () => {
      proc.kill();
      await proc.exited.catch(() => {});
    },
  };
}

interface ServeSubprocess {
  stdout: ReadableStream<Uint8Array>;
  kill(): unknown;
  exited: Promise<unknown>;
}

async function waitForListeningUrl(proc: ServeSubprocess, timeoutMs: number): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      proc.kill();
      throw new Error(`opencode serve no levantó en ${timeoutMs}ms (stdout: ${buffer.slice(0, 200)})`);
    }
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`opencode serve terminó antes de levantar (stdout: ${buffer.slice(0, 200)})`);
    }
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(/server listening on\s+(https?:\/\/\S+)/);
    if (match?.[1]) {
      reader.cancel().catch(() => {});
      return match[1];
    }
  }
}

export function memberAuthHeader(member: FleetMember): Record<string, string> | undefined {
  return member.password ? { Authorization: basicAuth(member.password) } : undefined;
}

export class Fleet {
  #members: FleetMember[] = [];
  #cursor = 0;

  add(member: FleetMember): void {
    this.#members.push(member);
  }

  list(): readonly FleetMember[] {
    return this.#members;
  }

  get size(): number {
    return this.#members.length;
  }

  /** Round-robin simple (cooldown/rotación inteligente entran en el hito 3). */
  pickNext(): FleetMember | undefined {
    if (this.#members.length === 0) return undefined;
    const member = this.#members[this.#cursor % this.#members.length];
    this.#cursor += 1;
    return member;
  }

  async closeAll(): Promise<void> {
    for (const member of this.#members) await member.close();
    this.#members = [];
  }
}
