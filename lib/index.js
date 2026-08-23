import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createAgentBridge } from "./agent-bridge.js";
import { createGatewayServer } from "./server.js";

/** Stable Cordis plugin name (patch-layer id). */
const name = "openai-gateway";

/** Core services required before a turn can start (mirrors dsh-headless). */
const inject = ["agentDefaultModel", "agents", "sessions"];

const Config = z.object({
	enabled: z.boolean().default(true),
	host: z.string().default("127.0.0.1"),
	port: z.natural().max(65535).default(41540),
	apiKeys: z.array(z.string().min(8)).default([]),
	// "both": stateless by default, sticky via X-DSH-Session header / dsh_session body field.
	// "stateless": sticky identifiers are refused.
	sessionMode: z.union([z.const("both"), z.const("stateless")]).default("both"),
	maxSessions: z.natural().min(1).max(200).default(16),
	timeoutSeconds: z.natural().min(10).max(3600).default(300),
	defaultModel: z.string().default(""),
	workspace: z.object({
		cwd: z.string().default(""),
	}).default({}),
});

function resolveWorkspace(config) {
	if (config.workspace.cwd !== "") return config.workspace.cwd;
	return dshHomePath("openai-gateway", "workspace");
}

/**
 * Explicitly configured keys win. Otherwise one key is generated on first
 * boot and persisted (0600, atomic rename) so it survives restarts.
 */
function resolveApiKeys(config, logger) {
	if (config.apiKeys.length > 0) return [...config.apiKeys];
	const file = dshHomePath("openai-gateway", "api-keys.json");
	try {
		if (existsSync(file)) {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			if (Array.isArray(parsed.keys) && parsed.keys.length > 0) return parsed.keys;
		}
	} catch (error) {
		logger(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const key = `sk-dsh-${randomBytes(24).toString("hex")}`;
	try {
		mkdirSync(dshHomePath("openai-gateway"), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ keys: [key] }, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	} catch (error) {
		logger(`cannot persist generated API key to ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	logger(`generated API key (stored in ${file}): ${key}`);
	return [key];
}

/**
 * Boot the gateway: resolve keys, bind the plugin-owned HTTP listener, and
 * tie its whole lifecycle to this context.
 */
function apply(ctx, config) {
	if (!config.enabled) return;
	const logger = (message) => ctx.logger("openai-gateway").info(message);
	const keys = resolveApiKeys(config, logger);
	const bridge = createAgentBridge(ctx, {
		config,
		cwd: resolveWorkspace(config),
		logger: (message) => ctx.logger("openai-gateway").info(message),
	});
	const server = createGatewayServer({ bridge, keys, config, logger });
	server.listen(config.port, config.host, () => {
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : config.port;
		logger(`OpenAI-compatible API listening on http://${config.host}:${port} (/v1/chat/completions, /v1/models)`);
	});
	ctx.effect(() => () => {
		server.closeIdleConnections?.();
		server.close();
		bridge.dispose();
	}, "openai-gateway: http listener");
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
