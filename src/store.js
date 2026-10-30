// File-backed vault store. Each vault is one JSON document written
// atomically (temp file + rename). The local profile has a single vault;
// the hosted demo gives every browser session its own synthetic vault.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export class VaultStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid vault id.");
    return path.join(this.dir, `${id}.json`);
  }

  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const f = this.file(id);
    if (!fs.existsSync(f)) return null;
    const vault = JSON.parse(fs.readFileSync(f, "utf8"));
    this.cache.set(id, vault);
    return vault;
  }

  put(id, vault) {
    vault.updatedAt = new Date().toISOString();
    this.cache.set(id, vault);
    const f = this.file(id);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(vault, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  remove(id) {
    this.cache.delete(id);
    fs.rmSync(this.file(id), { force: true });
  }

  ids() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  }
}
