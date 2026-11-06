import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyOauthEngineConfig, bundledOpencodeBin, fleetEnv, fleetHome, isOpencodeAvailable, resolveOpencodeBin, spawnMember, vendoredOpencodeBin } from "../src/index";

describe("motor empaquetado (nunca el del sistema)", () => {
  test("el binario vendorizado (engine/) manda si existe; si no, el del paquete npm", () => {
    const vendored = vendoredOpencodeBin();
    expect(vendored === undefined || existsSync(vendored)).toBe(true);
    const resolved = resolveOpencodeBin();
    if (vendored) expect(resolved).toBe(vendored);
    const bundled = bundledOpencodeBin();
    if (!vendored && bundled) expect(resolved).toBe(bundled);
  });

  test("sin motor disponible, spawnMember falla con guidance (sin crear procesos)", async () => {
    const fake = "opencode-que-no-existe-en-patvh";
    expect(isOpencodeAvailable(fake)).toBe(false);
    let message = "";
    try {
      await spawnMember({ bin: fake });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("motor opencode");
    expect(message).toContain("opencode-ai");
    expect(message).toContain("url");
  });
});

describe("home aislado ~/.fleetproxy", () => {
  test("fleetHome apunta a ~/.fleetproxy", () => {
    expect(fleetHome()).toBe(join(homedir(), ".fleetproxy"));
  });

  test("fleetEnv aísla data, config y state bajo el home", () => {
    expect(fleetEnv("/home/x/.fleetproxy")).toEqual({
      XDG_DATA_HOME: "/home/x/.fleetproxy/data",
      XDG_CONFIG_HOME: "/home/x/.fleetproxy/config",
      XDG_STATE_HOME: "/home/x/.fleetproxy/state",
    });
  });
});

describe("applyOauthEngineConfig (OAuth headless con URL pública)", () => {
  test("fija callbackPort/redirectUri por provider sin pisar el resto de la config", () => {
    const home = mkdtempSync(join(tmpdir(), "fp-oauth-"));
    try {
      const file = join(home, "config", "opencode", "opencode.json");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          gitlab: { options: { instanceUrl: "https://gitlab.com" } },
          other: { options: { keep: 1 } },
        },
      }));
      const written = applyOauthEngineConfig({
        home,
        providers: ["gitlab"],
        callbackPort: 19821,
        redirectUri: "https://app.example/auth/callback",
      });
      expect(written).toBe(file);
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      expect(cfg.$schema).toBe("https://opencode.ai/config.json");
      expect(cfg.provider.gitlab.options).toEqual({
        instanceUrl: "https://gitlab.com",
        oauth: { callbackPort: 19821, redirectUri: "https://app.example/auth/callback" },
      });
      expect(cfg.provider.other.options.keep).toBe(1);
      // re-aplicar solo toca la clave oauth
      applyOauthEngineConfig({ home, providers: ["gitlab"], callbackPort: 19999, redirectUri: "https://x/auth/callback" });
      const again = JSON.parse(readFileSync(file, "utf8"));
      expect(again.provider.gitlab.options).toEqual({
        instanceUrl: "https://gitlab.com",
        oauth: { callbackPort: 19999, redirectUri: "https://x/auth/callback" },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("crea la config desde cero si el home está vacío", () => {
    const home = mkdtempSync(join(tmpdir(), "fp-oauth2-"));
    try {
      applyOauthEngineConfig({ home, providers: ["digitalocean", "gitlab"], callbackPort: 1, redirectUri: "r" });
      const cfg = JSON.parse(readFileSync(join(home, "config", "opencode", "opencode.json"), "utf8"));
      expect(Object.keys(cfg.provider)).toEqual(["digitalocean", "gitlab"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
