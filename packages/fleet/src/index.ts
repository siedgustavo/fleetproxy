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
  /** "shared" = reutiliza el perfil de opencode del usuario; si no, XDG_DATA_HOME propio */
  profile: "shared" | string;
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
    profile: "shared",
    spawned: false,
    close: () => {},
  };
}

/**
 * Spawnea un `opencode serve` local (binario en PATH) con password conocida.
 * Nota: el createOpencodeServer del SDK espera un stdout que opencode 2.2.x
 * ya no emite ("opencode server listening" vs "server listening"), así que
 * parseamos el stdout nosotros mismos.
 */
export function isOpencodeAvailable(bin = "opencode"): boolean {
  return Bun.which(bin) !== null;
}

export async function spawnMember(options: { port?: number; dataDir?: string; timeoutMs?: number; bin?: string } = {}): Promise<FleetMember> {
  const bin = options.bin ?? "opencode";
  if (!isOpencodeAvailable(bin)) {
    throw new Error(
      `No se encontró el binario \`${bin}\` en PATH. fleetproxy lo usa como runtime:\n` +
        "  - instalarlo:  curl -fsSL https://opencode.ai/install | bash   (o npm i -g opencode-ai)\n" +
        "  - o evitarlo:  configurá un server existente con { \"opencode\": { \"url\": \"...\" } } en fleetproxy.json (modo attach)",
    );
  }
  const port = options.port ?? 18_000 + Math.floor(Math.random() * 4_000);
  const password = `fleet-${crypto.randomUUID()}`;
  const env: Record<string, string> = { ...process.env as Record<string, string>, OPENCODE_SERVER_PASSWORD: password };
  if (options.dataDir) env.XDG_DATA_HOME = options.dataDir;

  const proc = Bun.spawn([bin, "serve", "--hostname=127.0.0.1", `--port=${port}`], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const url = await waitForListeningUrl(proc, options.timeoutMs ?? 60_000);

  return {
    id: nextId(),
    url,
    password,
    profile: options.dataDir ?? "shared",
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
