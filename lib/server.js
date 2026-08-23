import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { foldAssistantText } from "./agent-bridge.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "authorization, content-type, x-dsh-session",
	"access-control-max-age": "86400",
};

function sha256(text) {
	return createHash("sha256").update(text).digest();
}

function bearerOk(authorization, keys) {
	if (typeof authorization !== "string") return false;
	const match = /^Bearer\s+(.+)$/i.exec(authorization);
	if (match === null) return false;
	const digest = sha256(match[1].trim());
	return keys.some((key) => {
		try {
			return timingSafeEqual(digest, sha256(key));
		} catch {
			return false;
		}
	});
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		...CORS_HEADERS,
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

function sendError(res, status, message, code, type = "invalid_request_error") {
	sendJson(res, status, { error: { message, type, code } });
}

function sendErrorFrom(res, error) {
	const status = typeof error?.status === "number" ? error.status : 500;
	const code = typeof error?.code === "string" ? error.code : "internal_error";
	const type = status === 401 ? "authentication_error" : status === 404 ? "invalid_request_error" : status === 504 ? "request_timeout" : "server_error";
	sendJson(res, status, { error: { message: error instanceof Error ? error.message : String(error), type, code } });
}

function readBody(req, limit = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error(`request body exceeds ${limit} bytes`), { status: 413, code: "request_too_large" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function contentToText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
	}
	return content === undefined || content === null ? "" : String(content);
}

function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") return contentToText(messages[i].content);
	}
	return contentToText(messages[messages.length - 1]?.content);
}

/** Stateless mode: the whole OpenAI message history becomes one transcript prompt. */
function flattenPrompt(messages) {
	const lines = [];
	for (const message of messages) {
		const role = message?.role ?? "user";
		const text = contentToText(message.content);
		if (role === "system") lines.push(`[system instructions] ${text}`);
		else if (role === "assistant") lines.push(`[assistant said] ${text}`);
		else if (role === "tool") lines.push(`[tool result] ${text.slice(0, 2000)}`);
		else lines.push(`[user] ${text}`);
	}
	return [
		"You are continuing an OpenAI-compatible API conversation.",
		"The transcript below is the full message history. Respond ONLY with the assistant's next reply to the final user message, without role tags, transcripts, or meta commentary.",
		"",
		lines.join("\n\n"),
	].join("\n");
}

function chatId() {
	return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function finishReason(turnReason) {
	return turnReason?.kind === "completed" ? "stop" : turnReason?.kind === "length" ? "length" : "stop";
}

function emptyUsage() {
	return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function addUsage(total, usage) {
	if (usage === undefined) return;
	total.prompt_tokens += usage.inputTokens ?? 0;
	total.completion_tokens += usage.outputTokens ?? 0;
}

/** Filter only text chunks an OpenAI/DeepSeek client understands. */
function chunkDeltas(chunk) {
	if (chunk?.type === "text-delta" && typeof chunk.text === "string") return { content: chunk.text };
	if (chunk?.type === "reasoning-delta" && typeof chunk.text === "string") return { reasoning_content: chunk.text };
	return undefined;
}

/**
 * The plugin-owned OpenAI-compatible HTTP surface. Deliberately a separate
 * listener: the shared webServer's routes are all wrapped by login gates
 * (e.g. @xgone/dsh-remote) that demand browser sessions an API client
 * cannot hold — this server authenticates with its own Bearer keys.
 */
export function createGatewayServer({ bridge, keys, config, logger }) {
	function requireAuth(req, res) {
		if (bearerOk(req.headers.authorization, keys)) return true;
		sendError(res, 401, "missing or invalid API key (expected: Authorization: Bearer <key>)", "invalid_api_key", "authentication_error");
		return false;
	}

	async function handleModels(res, modelId) {
		const models = await bridge.listModels();
		if (modelId === undefined) {
			sendJson(res, 200, {
				object: "list",
				data: models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "deepseek-harness" })),
			});
			return;
		}
		const found = models.find((model) => model.id === modelId || model.id.endsWith(`/${modelId}`));
		if (found === undefined) {
			sendError(res, 404, `model '${modelId}' not found`, "model_not_found");
			return;
		}
		sendJson(res, 200, { id: found.id, object: "model", created: 0, owned_by: "deepseek-harness" });
	}

	async function handleChat(req, res) {
		const raw = await readBody(req);
		let body;
		try {
			body = JSON.parse(raw.toString("utf8") || "{}");
		} catch {
			sendError(res, 400, "request body is not valid JSON", "invalid_json");
			return;
		}
		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			sendError(res, 400, "'messages' must be a non-empty array", "invalid_request");
			return;
		}
		const requestedSessionId = typeof body.dsh_session === "string"
			? body.dsh_session
			: (typeof req.headers["x-dsh-session"] === "string" ? req.headers["x-dsh-session"] : "");
		if (config.sessionMode === "stateless" && requestedSessionId !== "") {
			sendError(res, 400, "sticky sessions are disabled (sessionMode: stateless)", "session_mode_stateless");
			return;
		}
		const stream = body.stream === true;
		const id = chatId();
		const created = Math.floor(Date.now() / 1000);
		const modelEcho = typeof body.model === "string" && body.model !== "" ? body.model : "default";

		const selection = await bridge.resolveModel(body.model);
		const session = await bridge.openSession({
			requestedSessionId,
			selection,
			maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
		});
		const prompt = session.sticky ? lastUserText(body.messages) : flattenPrompt(body.messages);

		const usage = emptyUsage();
		let toolCalls = 0;
		let turnReason;
		let lastText = "";

		const finish = () => {
			if (session.sticky) {
				bridge.flush(session.agent);
			} else {
				Promise.resolve(session.dispose()).catch(() => {});
			}
		};

		if (!stream) {
			await bridge.runTurn({
				agent: session.agent,
				sessionId: session.sessionId,
				prompt,
				timeoutMs: config.timeoutSeconds * 1000,
				onEvent: (event) => {
					if (event.type === "assistant/message") {
						const joined = foldAssistantText(event.data.message);
						if (joined !== "") lastText = joined;
						addUsage(usage, event.data.usage);
					} else if (event.type === "tool/call") {
						toolCalls += 1;
					} else if (event.type === "turn/end") {
						turnReason = event.data.reason;
					}
				},
			});
			sendJson(res, 200, {
				id,
				object: "chat.completion",
				created,
				model: modelEcho,
				choices: [{
					index: 0,
					message: { role: "assistant", content: lastText },
					finish_reason: finishReason(turnReason),
				}],
				usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
				dsh_session_id: session.sessionId,
				dsh_tool_calls: toolCalls,
			});
			finish();
			return;
		}

		res.writeHead(200, {
			...CORS_HEADERS,
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		const write = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		write({ id, object: "chat.completion.chunk", created, model: modelEcho, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

		let clientGone = false;
		res.on("close", () => {
			clientGone = true;
			try {
				session.agent.cancel("openai-gateway: client disconnected");
			} catch {
				// already stopped
			}
		});

		try {
			await bridge.runTurn({
				agent: session.agent,
				sessionId: session.sessionId,
				prompt,
				timeoutMs: config.timeoutSeconds * 1000,
				onEvent: (event) => {
					if (clientGone) return;
					if (event.type === "assistant/chunk") {
						const deltas = chunkDeltas(event.data.chunk);
						if (deltas !== undefined) {
							write({ id, object: "chat.completion.chunk", created, model: modelEcho, choices: [{ index: 0, delta: deltas, finish_reason: null }] });
						}
					} else if (event.type === "assistant/message") {
						const joined = foldAssistantText(event.data.message);
						if (joined !== "") lastText = joined;
						addUsage(usage, event.data.usage);
					} else if (event.type === "tool/call") {
						toolCalls += 1;
						res.write(`: dsh tool-call ${event.data.name}\n\n`);
					} else if (event.type === "turn/end") {
						turnReason = event.data.reason;
					}
				},
			});
		} catch (error) {
			if (!clientGone && !res.writableEnded) {
				res.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: "server_error" } })}\n\n`);
			}
		}
		if (!clientGone && !res.writableEnded) {
			write({
				id,
				object: "chat.completion.chunk",
				created,
				model: modelEcho,
				choices: [{ index: 0, delta: {}, finish_reason: finishReason(turnReason) }],
				usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
				dsh_session_id: session.sessionId,
				dsh_tool_calls: toolCalls,
			});
			res.write("data: [DONE]\n\n");
		}
		res.end();
		finish();
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		Promise.resolve()
			.then(async () => {
				if (req.method === "OPTIONS") {
					res.writeHead(204, CORS_HEADERS);
					res.end();
					return;
				}
				if (req.method === "GET" && (pathname === "/healthz" || pathname === "/v1/healthz")) {
					sendJson(res, 200, { ok: true, service: "dsh-openai-gateway" });
					return;
				}
				if (pathname === "/v1" || pathname.startsWith("/v1/")) {
					if (!requireAuth(req, res)) return;
					if (req.method === "GET" && pathname === "/v1/models") return handleModels(res);
					if (req.method === "GET" && pathname.startsWith("/v1/models/")) return handleModels(res, decodeURIComponent(pathname.slice("/v1/models/".length)));
					if (req.method === "POST" && pathname === "/v1/chat/completions") return handleChat(req, res);
					sendError(res, 404, `unknown route ${req.method} ${pathname}`, "not_found");
					return;
				}
				sendError(res, 404, `unknown route ${req.method} ${pathname}`, "not_found");
			})
			.catch((error) => {
				logger(`request failed: ${req.method} ${pathname}: ${error instanceof Error ? error.stack : String(error)}`);
				if (!res.headersSent) sendErrorFrom(res, error);
				else res.end();
			});
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	return server;
}
