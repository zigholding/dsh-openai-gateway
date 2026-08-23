import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

/** Only ids this gateway minted may be resumed — callers cannot probe arbitrary session ids. */
const SESSION_ID_PATTERN = /^openai-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function apiError(status, code, message) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
}

function foldAssistantText(message) {
	if (message?.content === undefined || !Array.isArray(message.content)) return "";
	return message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

/**
 * Owns everything agent-side: model resolution, session lifecycle
 * (stateless create+dispose, sticky live-reuse/resume), and one-turn
 * execution with a filtered session/event subscription.
 */
export function createAgentBridge(ctx, { config, cwd, logger }) {
	mkdirSync(cwd, { recursive: true });
	const stickyTouched = new Map();

	function defaultSelection() {
		const service = ctx.get("agentDefaultModel");
		const selection = service?.currentSelection?.() ?? {};
		return { provider: selection.provider, model: selection.model };
	}

	/**
	 * Accepts "provider/model", a bare model id matched against the catalog,
	 * or "default". Unknown bare ids ride the default provider route and let
	 * the provider fail loud upstream rather than second-guessing here.
	 */
	async function resolveModel(requested) {
		const fallback = defaultSelection();
		let effective = typeof requested === "string" && requested !== "" ? requested : config.defaultModel;
		if (effective === "" || effective === "default") return fallback;
		const llm = ctx.get("llm");
		if (llm !== undefined) {
			const slash = effective.indexOf("/");
			try {
				if (slash > 0 && llm.listProviders().some((entry) => entry.id === effective.slice(0, slash))) {
					return { provider: effective.slice(0, slash), model: effective.slice(slash + 1) };
				}
				if (slash < 0) {
					for (const entry of llm.listProviders()) {
						const models = await llm.listModels(entry.id);
						if (models.some((model) => (model.id ?? model.name) === effective)) {
							return { provider: entry.id, model: effective };
						}
					}
				}
			} catch {
				// catalog unavailable → fall through to default route
			}
		}
		return { provider: fallback.provider, model: effective };
	}

	async function listModels() {
		const models = [];
		const llm = ctx.get("llm");
		if (llm !== undefined) {
			try {
				for (const provider of llm.listProviders()) {
					let catalog = [];
					try {
						catalog = await llm.listModels(provider.id);
					} catch {
						continue;
					}
					for (const model of catalog) {
						const id = model.id ?? model.name;
						if (id !== undefined) models.push({ id: `${provider.id}/${id}` });
					}
				}
			} catch {
				// fall through to fallback list
			}
		}
		const fallback = defaultSelection();
		if (fallback.provider !== undefined && fallback.model !== undefined) {
			const id = `${fallback.provider}/${fallback.model}`;
			if (!models.some((entry) => entry.id === id)) models.unshift({ id });
		}
		if (models.length === 0) {
			return [{ id: "default" }, { id: "deepseek-chat" }, { id: "deepseek-reasoner" }];
		}
		return models;
	}

	function agentOptions(selection, maxTokens) {
		return {
			provider: selection.provider,
			model: selection.model,
			...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens } : {}),
		};
	}

	function makeSetup(selection) {
		return (agentCtx) => {
			installModelSelection(agentCtx, { current: selection, assembled: void 0 });
		};
	}

	function touch(sessionId) {
		stickyTouched.set(sessionId, Date.now());
		while (stickyTouched.size > config.maxSessions) {
			let oldest;
			for (const [id, at] of stickyTouched) if (oldest === undefined || at < stickyTouched.get(oldest)) oldest = id;
			stickyTouched.delete(oldest);
		}
	}

	/**
	 * Sticky mode reuses the live agent (or resumes the persisted session);
	 * stateless mode mints a fresh session the caller must dispose. Sticky
	 * handles are intentionally never disposed here — the registry keeps the
	 * agent alive so the next call reuses it.
	 */
	async function openSession({ requestedSessionId, selection, maxTokens }) {
		if (config.sessionMode === "both" && typeof requestedSessionId === "string" && requestedSessionId !== "") {
			// "new" mints a fresh sticky session the caller keeps alive by id.
			if (requestedSessionId === "new") {
				const sessionId = `openai-${randomUUID()}`;
				const { agent } = await ctx.agents.create({
					sessionId: SessionId(sessionId),
					meta: { cwd },
					agentOptions: agentOptions(selection, maxTokens),
					setup: makeSetup(selection),
				});
				touch(sessionId);
				return { agent, sessionId, sticky: true };
			}
			if (!SESSION_ID_PATTERN.test(requestedSessionId)) {
				throw apiError(404, "session_not_found", "unknown dsh session id");
			}
			if (typeof ctx.agents.get === "function") {
				const live = ctx.agents.get(requestedSessionId);
				if (live !== undefined) {
					touch(requestedSessionId);
					return { agent: live, sessionId: requestedSessionId, sticky: true };
				}
			}
			try {
				const { agent } = await ctx.agents.resume({
					resumeSessionId: SessionId(requestedSessionId),
					agentOptions: agentOptions(selection, maxTokens),
					setup: makeSetup(selection),
				});
				touch(requestedSessionId);
				return { agent, sessionId: requestedSessionId, sticky: true };
			} catch (error) {
				throw apiError(404, "session_not_found", `cannot resume session: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const sessionId = `openai-${randomUUID()}`;
		const { agent, dispose } = await ctx.agents.create({
			sessionId: SessionId(sessionId),
			meta: { cwd },
			agentOptions: agentOptions(selection, maxTokens),
			setup: makeSetup(selection),
		});
		return { agent, sessionId, dispose, sticky: false };
	}

	/**
	 * Drive one turn: enqueue the user message, forward this session's new
	 * events to onEvent until the agent goes idle or the timeout cancels it.
	 */
	async function runTurn({ agent, sessionId, prompt, timeoutMs, onEvent }) {
		const firstSeq = agent.session.seq;
		const off = ctx.on("session/event", (session, event) => {
			if (session !== agent.session && String(session?.id ?? "") !== sessionId) return;
			if (typeof event.seq === "number" && event.seq <= firstSeq) return;
			onEvent(event);
		});
		let timer;
		const timeout = new Promise((_resolve, reject) => {
			timer = setTimeout(() => {
				try {
					agent.cancel("openai-gateway: turn timeout");
				} catch {
					// agent may already be stopped
				}
				reject(apiError(504, "timeout", `agent turn exceeded ${Math.round(timeoutMs / 1000)}s and was cancelled`));
			}, timeoutMs);
		});
		agent.followup(createUserMessage({
			content: [{ type: "text", text: prompt }],
			source: { kind: "user" },
		}));
		try {
			await Promise.race([agent.whenIdle(), timeout]);
		} finally {
			clearTimeout(timer);
			off();
		}
	}

	function flush(agent) {
		Promise.resolve(ctx.sessions.flush(agent.session)).catch(() => {});
	}

	function dispose() {
		stickyTouched.clear();
	}

	return { resolveModel, listModels, openSession, runTurn, flush, dispose };
}

export { foldAssistantText };
