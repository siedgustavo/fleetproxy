import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { bundledOpencodeBin, isOpencodeAvailable, resolveOpencodeBin, spawnMember } from "../src/index";

describe("spawnMember sin opencode instalado", () => {
  test("falla con guidance amigable en lugar de un crash crudo", async () => {
    const bin = "opencode-que-no-existe-en-patvh";
    expect(isOpencodeAvailable(bin)).toBe(false);
    let message = "";
    try {
      await spawnMember({ bin });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("No se encontró el binario");
    expect(message).toContain("opencode.ai/install");
    expect(message).toContain("attach");
  });

  test("isOpencodeAvailable responde boolean sin crashear", () => {
    // En máquinas con opencode instalado da true; en CI sin él ni empaquetado, false.
    expect(typeof isOpencodeAvailable()).toBe("boolean");
  });
});

describe("resolución del runtime opencode", () => {
  test("el binario empaquetado (dependencia opencode-ai) existe si está instalado", () => {
    const bundled = bundledOpencodeBin();
    if (bundled) expect(existsSync(bundled)).toBe(true);
  });

  test("orden: preferido explícito → FLEETPROXY_OPENCODE_BIN → PATH → empaquetado", () => {
    expect(resolveOpencodeBin("/bin/preferido")).toBe("/bin/preferido");
    const saved = process.env.FLEETPROXY_OPENCODE_BIN;
    process.env.FLEETPROXY_OPENCODE_BIN = "/ruta/custom/opencode";
    expect(resolveOpencodeBin()).toBe("/ruta/custom/opencode");
    if (saved === undefined) delete process.env.FLEETPROXY_OPENCODE_BIN;
    else process.env.FLEETPROXY_OPENCODE_BIN = saved;
    // sin overrides: PATH si hay binario, si no el empaquetado, si no "opencode"
    const resolved = resolveOpencodeBin();
    expect(typeof resolved).toBe("string");
    expect(resolved).not.toBe("/ruta/custom/opencode");
  });
});
