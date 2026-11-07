/**
 * Genera la tabla del catálogo de providers en docs/PROVIDERS.md (entre los
 * markers BEGIN/END). Corre el motor in-process con un home temporal (sin
 * credenciales ni envs del host) y lista Integration.list() — el mismo
 * IntegrationList que sirve `fleetproxy providers` / GET /auth/providers.
 *
 * Determinista a propósito: sin fecha ni conexiones en la salida, así el diff
 * solo cambia cuando cambia el catálogo (models.dev) y la CI commitea sola.
 *
 *   bun run docs:providers
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// import relativo: el paquete del workspace no resuelve desde scripts/ (solo desde cli/)
import { startEngine } from "../packages/core/src/engine";

const BEGIN = "<!-- BEGIN providers-catalogo (autogenerado por scripts/gen-providers-doc.ts; no editar a mano) -->";
const END = "<!-- END providers-catalogo -->";

// El runtime de core loguea INFO por stdout/console.log: a stderr para que el
// script sea silencioso (no hay env en core 2.2.6 para bajar ese sink).
const stdout = process.stdout;
const realLog = console.log.bind(console);
const fmt = (args: unknown[]) => `${args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ")}\n`;
console.log = (...args: unknown[]) => process.stderr.write(fmt(args));
Object.defineProperty(process, "stdout", { value: process.stderr, configurable: true, writable: true });

const home = mkdtempSync(join(tmpdir(), "fp-providers-doc-"));
let count = 0;
let table = "";
try {
  const engine = await startEngine({
    xdg: { dataHome: join(home, "data"), configHome: join(home, "config"), stateHome: join(home, "state") },
    directory: home,
  });
  try {
    const providers = await engine.providers();
    count = providers.length;
    const rows = providers.map((p) => `| \`${p.id}\` | ${p.methods.map((m) => `\`${m.type}:${m.id}\``).join(" · ") || "—"} |`);
    table = [
      `**${count} providers** en el catálogo vivo de [models.dev](https://models.dev) (los que tienen`,
      "`·` en MÉTODOS se ligan con `fleetproxy login`; el resto toma su API key por env,",
      "p. ej. `GROQ_API_KEY`). Las conexiones activas del server que corre, en vivo:",
      "`fleetproxy providers` o `GET /auth/providers`.",
      "",
      "| PROVIDER | MÉTODOS DE AUTH |",
      "|---|---|",
      ...rows,
    ].join("\n");
  } finally {
    await engine.close();
  }
} finally {
  Object.defineProperty(process, "stdout", { value: stdout, configurable: true, writable: true });
  console.log = realLog;
  rmSync(home, { recursive: true, force: true });
}

const file = join(import.meta.dir, "..", "docs", "PROVIDERS.md");
const doc = readFileSync(file, "utf8");
const begin = doc.indexOf(BEGIN);
const end = doc.indexOf(END);
if (begin < 0 || end < 0) {
  console.error(`gen-providers-doc: faltan los markers en ${file}`);
  process.exit(1);
}
const next = `${doc.slice(0, begin + BEGIN.length)}\n\n${table}\n\n${doc.slice(end)}`;
if (next !== doc) writeFileSync(file, next);
console.log(`docs/PROVIDERS.md: ${count} providers ${next !== doc ? "(actualizado)" : "(sin cambios)"}`);
