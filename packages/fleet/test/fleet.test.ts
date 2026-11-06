import { describe, expect, test } from "bun:test";
import { isOpencodeAvailable, spawnMember } from "../src/index";

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
    // En máquinas con opencode instalado da true; en CI sin él, false.
    expect(typeof isOpencodeAvailable()).toBe("boolean");
  });
});
