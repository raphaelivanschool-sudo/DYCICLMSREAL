/**
 * API key for HTTP calls to the Python PC agent (Flask on port 5555, /project).
 *
 * Resolution order:
 * 1. PC_AGENT_API_KEY in environment (server/.env)
 * 2. JSON file: PC_AGENT_CONFIG_PATH if set
 * 3. Repo default: agent/pc-agent/python/agent_config.json (same file guests use)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedKey = undefined;
let cachedPath = undefined;

function defaultConfigPath() {
  return path.join(
    __dirname,
    "..",
    "..",
    "agent",
    "pc-agent",
    "python",
    "agent_config.json",
  );
}

/**
 * @returns {string} Bearer token for Python agent, or "" if unavailable
 */
export function getPcAgentApiKey() {
  const fromEnv = (process.env.PC_AGENT_API_KEY || "").trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (cachedKey !== undefined) {
    return cachedKey;
  }

  const configPath = (
    process.env.PC_AGENT_CONFIG_PATH || ""
  ).trim() || defaultConfigPath();

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const j = JSON.parse(raw);
    const k = typeof j.api_key === "string" ? j.api_key.trim() : "";
    cachedKey = k || "";
    cachedPath = configPath;
    if (cachedKey && process.env.NODE_ENV !== "production") {
      console.info(
        `[pcAgentAuth] Using api_key from ${configPath} (set PC_AGENT_API_KEY to override)`,
      );
    }
    return cachedKey;
  } catch (e) {
    cachedKey = "";
    cachedPath = configPath;
    return "";
  }
}

/** Call after changing agent_config.json at runtime (tests only). */
export function clearPcAgentApiKeyCache() {
  cachedKey = undefined;
  cachedPath = undefined;
}

export function getPcAgentConfigPathTried() {
  return cachedPath || defaultConfigPath();
}
