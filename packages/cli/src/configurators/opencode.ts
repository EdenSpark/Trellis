import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { AI_TOOLS } from "../types/ai-tools.js";
import { getOpenCodeTemplatePath } from "../templates/extract.js";
import { toPosix } from "../utils/posix.js";
import {
  collectSkillTemplates,
  replacePythonCommandLiterals,
  resolveBundledSkills,
  resolveCommands,
  resolveSkills,
  writeTemplateMap,
} from "./shared.js";

/**
 * Files under packages/cli/src/templates/opencode/ that are NOT user-facing
 * assets (build artifacts, runtime caches, etc.). OpenCode v2 loads the
 * plugin files directly and the plugins only import Node built-ins plus the
 * sibling lib/ modules, so the template ships no package.json (v2 does not
 * read `.opencode/package.json`).
 */
const EXCLUDE_PATTERNS = [
  ".d.ts",
  ".d.ts.map",
  ".js.map",
  "__pycache__",
  "node_modules",
  "bun.lock",
  ".gitignore",
];

function shouldExclude(filename: string): boolean {
  for (const pattern of EXCLUDE_PATTERNS) {
    if (filename.endsWith(pattern) || filename === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Walk the opencode template directory and produce a `Map<relPath, content>`
 * rooted at `.opencode/`. Shared by both `configureOpenCode` (init-time write)
 * and `collectOpenCodeTemplates` (update-time hash tracking) so the two paths
 * always agree on the exact file set. `commands/` is handled separately (sourced
 * from common template context, not from this directory tree).
 */
function walkOpenCodeTemplateDir(): Map<string, string> {
  const files = new Map<string, string>();
  const sourcePath = getOpenCodeTemplatePath();

  function walk(relDir: string): void {
    const absDir = path.join(sourcePath, relDir);
    for (const entry of readdirSync(absDir)) {
      if (shouldExclude(entry)) continue;
      const absEntry = path.join(absDir, entry);
      const relEntry = relDir ? path.join(relDir, entry) : entry;
      const stat = statSync(absEntry);
      if (stat.isDirectory()) {
        // Skip commands/ — that's sourced from common/ templates, not the
        // opencode/ dir. Including both paths would double-write.
        if (relEntry === "commands") continue;
        walk(relEntry);
      } else {
        const content = readFileSync(absEntry, "utf-8");
        // Map keys are logical paths used as cross-platform hash keys / lookup
        // keys downstream. Always POSIX, regardless of host OS.
        files.set(
          toPosix(path.join(".opencode", relEntry)),
          replacePythonCommandLiterals(content),
        );
      }
    }
  }

  walk("");
  return files;
}

/**
 * The opencode file set — written at init and diffed by `trellis update`.
 */
export function collectOpenCodeTemplates(): Map<string, string> {
  const files = walkOpenCodeTemplateDir();
  const ctx = AI_TOOLS.opencode.templateContext;
  for (const cmd of resolveCommands(ctx)) {
    files.set(`.opencode/commands/trellis/${cmd.name}.md`, cmd.content);
  }
  for (const [filePath, content] of collectSkillTemplates(
    ".opencode/skills",
    resolveSkills(ctx),
    resolveBundledSkills(ctx),
  )) {
    files.set(filePath, content);
  }
  return files;
}

/** Upper bound for `opencode --version` probing — never stall init/update. */
const OPENCODE_VERSION_TIMEOUT_MS = 3000;

/**
 * Best-effort OpenCode v2 gate (R7). Trellis's `.opencode/` templates now
 * target OpenCode v2 (`permissions:` array, v2 plugin API). Probe the local
 * `opencode --version` (output looks like `opencode v2.3.2`) and warn when
 * the installed major version is below 2. Missing binary, timeout, non-zero
 * exit, and unparseable output are all silently skipped — never blocks,
 * never changes the exit code.
 */
export function warnIfOpenCodeBelowV2(): void {
  let output: string;
  try {
    output = execFileSync("opencode", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: OPENCODE_VERSION_TIMEOUT_MS,
    });
  } catch {
    // opencode not installed, timed out, or exited non-zero — silent skip.
    return;
  }
  const match = /(\d+)\.\d+\.\d+/.exec(output);
  if (!match) {
    return;
  }
  const major = Number.parseInt(match[1], 10);
  if (Number.isNaN(major) || major >= 2) {
    return;
  }
  process.stderr.write(
    chalk.yellow(
      `⚠️  Detected OpenCode ${match[0]} — Trellis's OpenCode templates now require OpenCode v2. Please upgrade: https://opencode.ai\n` +
        `   检测到 OpenCode ${match[0]}：Trellis 的 OpenCode 模板已迁移到 v2，请升级 OpenCode（https://opencode.ai）。\n`,
    ),
  );
}

/**
 * Configure OpenCode at init time: write the collected file set, then the
 * one thing a `Map<path, content>` cannot carry — the v2 version gate.
 */
export async function configureOpenCode(cwd: string): Promise<void> {
  await writeTemplateMap(cwd, collectOpenCodeTemplates());
  warnIfOpenCodeBelowV2();
}
