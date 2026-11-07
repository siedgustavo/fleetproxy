// Decode del credential guardado contra el schema 2.2.6 (run desde packages/core)
import { Database } from "bun:sqlite";
const db = new Database("/home/fleetproxy/.fleetproxy/data/opencode/opencode.db", { readonly: true });
const value = JSON.parse(db.query("select value from credential").all()[0].value);
const { Credential } = await import("@opencode/core/credential");
const { Schema } = await import("effect");
let dec: string;
try {
  dec = "DECODE OK → " + JSON.stringify(Schema.decodeUnknownSync(Credential.Value)(value)).slice(0, 140);
} catch (e) {
  dec = "DECODE FAIL: " + String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 500);
}
console.log(dec);
