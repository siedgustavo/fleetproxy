import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bundledOpencodeBin, fleetEnv, fleetHome, isOpencodeAvailable, resolveOpencodeBin, spawnMember } from "../src/index";

describe("motor empaquetado (nunca el del sistema)", () => {
  test("el binario de la dependencia opencode-ai existe y es la resolución por defecto", () => {
    const bundled = bundledOpencodeBin();
    if (bundled) {
      expect(existsSync(bundled)).toBe(true);
      expect(resolveOpencodeBin()).toBe(bundled);
    }
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
