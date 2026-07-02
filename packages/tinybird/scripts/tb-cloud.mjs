#!/usr/bin/env node
/* ============================================================
   tb-cloud.mjs — run a `tb` command against Tinybird Cloud with
   explicit --host/--token, sourced from the repo-root .tinyb.

   `tb --cloud ...` reconciles the current folder against a
   "tracked folder" recorded in .tinyb; on a machine where that
   file is shared across unrelated Tinybird projects, the tracked
   folder can point elsewhere and the CLI blocks on an interactive
   "Are you sure you want to continue?" prompt — fatal for a
   non-interactive script. Passing --host/--token explicitly skips
   that reconciliation, so this wrapper reads them out of .tinyb
   and forwards everything else to `tb`.
   ============================================================ */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const rootTinyb = join(here, "..", "..", "..", ".tinyb");

let creds;
try {
  creds = JSON.parse(readFileSync(rootTinyb, "utf8"));
} catch (err) {
  console.error(`Could not read Tinybird credentials at ${rootTinyb}.`);
  console.error(`Run "tb login" from the repo root first.`);
  console.error(String(err));
  process.exit(1);
}

const res = spawnSync(
  "tb",
  ["--host", creds.host, "--token", creds.token, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env }
);
process.exit(res.status ?? 1);
