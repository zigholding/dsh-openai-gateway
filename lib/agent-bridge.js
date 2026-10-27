import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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
 * Expand a leading `~/` and require an absolute, existing directory.
 * Returns the `fs.realpath` canon so it matches dsh workspace registry paths.
 */
function resolveCwd(requested, defaultCwd) {
	let raw = typeof requested === "string" && requested.trim() !== "" ? requested.trim() : defaultCwd;
	if (raw === "~") raw = homedir();
	else if (raw.startsWith("~/") || raw.startsWith("~\\")) raw = join(homedir(), raw.slice(2));
	if (!isAbsolute(raw)) {
		throw apiError(400, "invalid_workspace", `workspace path must be absolute (got '${raw}')`);
	}
	try {
		const real = realpathSync(raw);
		if (!statSync(real).isDirectory()) {
			throw apiError(400, "invalid_workspace", `workspace is not a directory: ${raw}`);
		}
		return real;
	} catch (error) {
		if (error?.status !== undefined) throw error;
		throw apiError(400, "invalid_workspace", `workspace path does not exist: ${raw}`);
	}
}

/**
 * Owns everything agent-side: model resolution, session lifecycle
 * (stateless create+dispose, sticky live-reuse/resume), workspace cwd
 * resolution / Web UI workspace attach, and one-turn execution with a
 * filtered session/event subscription.
 */
export function createAgentBridge(ctx, { config, cwd: defaultCwd, logger }) {
	if (!existsSync(defaultCwd)) mkdirSync(defaultCwd, { recursive: true });
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

	function presetRegistry() {
		return ctx.get("agentPresets");
	}

	function permissionRegistry() {
		return ctx.get("permissionPresets");
	}

	/**
	 * Validate an agent preset id (empty → host default, no mount).
	 * @returns preset id to mount, or "" when the session follows the default.
	 */
	async function resolveAgentPreset(requested) {
		const raw = typeof requested === "string" ? requested.trim() : "";
		const wanted = raw !== "" ? raw : (config.agentPreset ?? "").trim();
		if (wanted === "") return "";
		const registry = presetRegistry();
		if (registry === undefined) {
			throw apiError(503, "agent_preset_unavailable", "agent presets are unavailable: agentPresets service not mounted");
		}
		try {
			const resolved = await registry.resolve(wanted);
			if (typeof resolved?.broken === "string") {
				throw apiError(400, "invalid_agent_preset", `agent preset '${wanted}' failed to activate: ${resolved.broken}`);
			}
			return resolved.id;
		} catch (error) {
			if (error?.status !== undefined) throw error;
			const available = error?.details?.available;
			throw apiError(400, "invalid_agent_preset", Array.isArray(available)
				? `${error.message} (available: ${available.join(", ")})`
				: String(error instanceof Error ? error.message : error));
		}
	}

	/** Validate a permission preset name without mutating any session. */
	function resolvePermissionPreset(requested) {
		const raw = typeof requested === "string" ? requested.trim() : "";
		const wanted = raw !== "" ? raw : (config.permissionPreset ?? "").trim();
		if (wanted === "") return "";
		const service = permissionRegistry();
		if (service === undefined) {
			throw apiError(503, "permission_preset_unavailable", "permission presets are unavailable: permissionPresets service not mounted");
		}
		try {
			service.resolve(wanted);
			return wanted;
		} catch (error) {
			throw apiError(400, "invalid_permission_preset", String(error instanceof Error ? error.message : error));
		}
	}

	/** Apply a validated permission preset to a freshly created session. */
	function applyPermissionPreset(session, name) {
		if (name === "") return "";
		permissionRegistry().set(session, name);
		return name;
	}

	function makeSetup(selection, agentPreset = "") {
		return async (agentCtx) => {
			if (agentPreset !== "") {
				const registry = presetRegistry();
				if (registry !== undefined) await registry.mount(agentCtx, agentPreset);
			}
			installModelSelection(agentCtx, { current: selection, assembled: void 0 });
		};
	}

	/** Read the preset / permission identity an existing session already carries. */
	function currentAgentPreset(agent) {
		const projections = ctx.get("sessionProjections");
		if (projections !== undefined && typeof projections.stateOf === "function") {
			try {
				const state = projections.stateOf(agent.session, "agentPreset");
				if (typeof state === "string" && state !== "") return state;
			} catch {
				// fall through to header
			}
		}
		const fromHeader = agent?.session?.header?.agentPreset;
		return typeof fromHeader === "string" ? fromHeader : "";
	}

	function currentPermissionPreset(agent) {
		const service = permissionRegistry();
		if (service === undefined || typeof service.current !== "function") return "";
		try {
			const value = service.current(agent.session);
			return typeof value === "string" ? value : "";
		} catch {
			return "";
		}
	}

	/**
	 * Create one session with optional agent preset mount. Mirrors the dsh
	 * webhook path: resolve → acquireScope → create(meta.agentPreset + setup
	 * mount), then release the scope lease.
	 */
	async function createSession({ sessionId, cwd, selection, maxTokens, agentPreset }) {
		const registry = presetRegistry();
		const scope = agentPreset !== "" && registry !== undefined ? await registry.acquireScope(agentPreset) : undefined;
		try {
			return await ctx.agents.create({
				sessionId: SessionId(sessionId),
				meta: { cwd, ...agentPreset === "" ? {} : { agentPreset } },
				agentOptions: agentOptions(selection, maxTokens),
				setup: makeSetup(selection, agentPreset),
			});
		} catch (error) {
			throw apiError(500, "session_create_failed", `cannot create session: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (scope !== undefined) await scope[Symbol.asyncDispose]?.();
		}
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
	 * Best-effort: if a Web UI workspace owns this cwd, put the new session
	 * on its membership list so the sidebar shows it under that group instead
	 * of "Ungrouped". Failure never blocks the API turn.
	 */
	async function tryAttachWorkspace(sessionId, sessionCwd) {
		const registry = ctx.get("workspaceRegistry");
		if (registry === undefined || typeof registry.resolveByPath !== "function") return;
		try {
			const workspace = await registry.resolveByPath(sessionCwd);
			if (workspace === undefined) {
				logger(`workspace: no registered workspace for ${sessionCwd} (session stays ungrouped)`);
				return;
			}
			await workspace.attachSession(SessionId(sessionId));
			logger(`workspace: attached ${sessionId} → ${workspace.title ?? workspace.path}`);
		} catch (error) {
			logger(`workspace: attach ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function sessionCwdOf(agent) {
		const headerCwd = agent?.session?.header?.cwd ?? agent?.session?.cwd;
		if (typeof headerCwd === "string" && headerCwd !== "") {
			try {
				return realpathSync(headerCwd);
			} catch {
				return headerCwd;
			}
		}
		return defaultCwd;
	}

	/**
	 * Sticky mode reuses the live agent (or resumes the persisted session);
	 * stateless mode mints a fresh session the caller must dispose. Sticky
	 * handles are intentionally never disposed here — the registry keeps the
	 * agent alive so the next call reuses it.
	 *
	 * `requestedCwd` / `requestedAgentPreset` / `requestedPermissionPreset`
	 * only apply when minting a new session. Resume / live reuse keeps the
	 * session's original cwd and presets (OpenAI clients resend headers).
	 */
	async function openSession({ requestedSessionId, requestedCwd, requestedAgentPreset = "", requestedPermissionPreset = "", selection, maxTokens }) {
		if (config.sessionMode === "both" && typeof requestedSessionId === "string" && requestedSessionId !== "") {
			// "new" mints a fresh sticky session the caller keeps alive by id.
			if (requestedSessionId === "new") {
				const cwd = resolveCwd(requestedCwd, defaultCwd);
				const agentPreset = await resolveAgentPreset(requestedAgentPreset);
				const permissionPreset = resolvePermissionPreset(requestedPermissionPreset);
				const sessionId = `openai-${randomUUID()}`;
				const { agent } = await createSession({ sessionId, cwd, selection, maxTokens, agentPreset });
				const applied = applyPermissionPreset(agent.session, permissionPreset);
				await tryAttachWorkspace(sessionId, cwd);
				touch(sessionId);
				return {
					agent, sessionId, sticky: true, cwd,
					agentPreset: currentAgentPreset(agent),
					permissionPreset: currentPermissionPreset(agent) || applied,
				};
			}
			if (!SESSION_ID_PATTERN.test(requestedSessionId)) {
				throw apiError(404, "session_not_found", "unknown dsh session id");
			}
			if (typeof ctx.agents.get === "function") {
				const live = ctx.agents.get(requestedSessionId);
				if (live !== undefined) {
					touch(requestedSessionId);
					return {
						agent: live, sessionId: requestedSessionId, sticky: true, cwd: sessionCwdOf(live),
						agentPreset: currentAgentPreset(live), permissionPreset: currentPermissionPreset(live),
					};
				}
			}
			try {
				const { agent } = await ctx.agents.resume({
					resumeSessionId: SessionId(requestedSessionId),
					agentOptions: agentOptions(selection, maxTokens),
					setup: makeSetup(selection, ""),
				});
				touch(requestedSessionId);
				return {
					agent, sessionId: requestedSessionId, sticky: true, cwd: sessionCwdOf(agent),
					agentPreset: currentAgentPreset(agent), permissionPreset: currentPermissionPreset(agent),
				};
			} catch (error) {
				throw apiError(404, "session_not_found", `cannot resume session: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const cwd = resolveCwd(requestedCwd, defaultCwd);
		const agentPreset = await resolveAgentPreset(requestedAgentPreset);
		const permissionPreset = resolvePermissionPreset(requestedPermissionPreset);
		const sessionId = `openai-${randomUUID()}`;
		const { agent, dispose } = await createSession({ sessionId, cwd, selection, maxTokens, agentPreset });
		const applied = applyPermissionPreset(agent.session, permissionPreset);
		await tryAttachWorkspace(sessionId, cwd);
		return {
			agent, sessionId, dispose, sticky: false, cwd,
			agentPreset: currentAgentPreset(agent), permissionPreset: currentPermissionPreset(agent) || applied,
		};
	}

	/** List registered agent presets and permission presets. */
	async function listPresets() {
		const registry = presetRegistry();
		const permission = permissionRegistry();
		const agentPresets = registry !== undefined ? await registry.list() : [];
		return {
			agent: agentPresets.map((entry) => ({
				id: entry.id,
				name: entry.name ?? "",
				description: entry.description ?? "",
				broken: entry.broken,
				isDefault: entry.id === registry.defaultId,
			})),
			permission: permission !== undefined ? permission.names.map((name) => {
				const option = permission.optionOf(name);
				return { name, description: option.description ?? "" };
			}) : [],
			defaults: {
				agentPreset: config.agentPreset ?? (registry?.defaultId ?? ""),
				permissionPreset: config.permissionPreset ?? (permission?.defaultPreset ?? ""),
			},
		};
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

	function workspaceIndex() {
		const registry = ctx.get("workspaceRegistry");
		const byPath = new Map();
		if (registry !== undefined && typeof registry.list === "function") {
			for (const workspace of registry.list()) {
				if (typeof workspace?.path === "string") {
					byPath.set(workspace.path, {
						path: workspace.path,
						title: typeof workspace.title === "string" ? workspace.title : "",
					});
				}
			}
		}
		return byPath;
	}

	function canonicalizeSessionCwd(cwd) {
		if (typeof cwd !== "string" || cwd === "") return "";
		try {
			return realpathSync(cwd);
		} catch {
			return cwd;
		}
	}

	/**
	 * Match a workspace filter against a session cwd / registered workspace title.
	 * Absolute existing paths compare by realpath; otherwise title or basename.
	 */
	function matchesWorkspaceFilter(cwd, workspaceTitle, filter) {
		if (typeof filter !== "string" || filter.trim() === "") return true;
		const trimmed = filter.trim();
		try {
			return cwd === resolveCwd(trimmed, trimmed);
		} catch {
			if (workspaceTitle !== "" && workspaceTitle === trimmed) return true;
			const base = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
			return base === trimmed;
		}
	}

	async function loadSessionHeaders() {
		const sessionQuery = ctx.get("sessionQuery");
		if (sessionQuery !== undefined && typeof sessionQuery.listSessions === "function") {
			const records = await sessionQuery.listSessions();
			return records
				.map((record) => record.header)
				.filter((header) => typeof header?.id === "string" && typeof header?.cwd === "string" && header.cwd !== "");
		}
		const persistence = ctx.get("sessionPersistence");
		if (persistence !== undefined && typeof persistence.list === "function") {
			const snapshots = await persistence.list();
			return snapshots
				.map((snapshot) => snapshot.header)
				.filter((header) => typeof header?.id === "string" && typeof header?.cwd === "string" && header.cwd !== "");
		}
		throw apiError(503, "sessions_unavailable", "session listing is unavailable: sessionQuery/sessionPersistence not mounted");
	}

	async function loadTitles(sessionIds) {
		const titles = new Map();
		if (sessionIds.length === 0) return titles;
		const sessionQuery = ctx.get("sessionQuery");
		if (sessionQuery !== undefined && typeof sessionQuery.readTitleSnapshots === "function") {
			const results = await sessionQuery.readTitleSnapshots(sessionIds);
			for (const result of results) {
				if (result.status !== "fulfilled") continue;
				const id = result.value?.session?.id;
				const snapshot = result.value?.title;
				if (typeof id === "string") {
					titles.set(id, typeof snapshot?.title === "string" ? snapshot.title : "");
				}
			}
			return titles;
		}
		// Fallback: live sessions only via sessionTitle service.
		const titleService = ctx.get("sessionTitle");
		if (titleService !== undefined && typeof titleService.get === "function") {
			for (const id of sessionIds) {
				const live = ctx.sessions?.get?.(id);
				if (live === undefined) {
					titles.set(id, "");
					continue;
				}
				const snapshot = titleService.get(live);
				titles.set(id, typeof snapshot?.title === "string" ? snapshot.title : "");
			}
		}
		return titles;
	}

	/**
	 * List durable sessions with workspace + title, optionally filtered.
	 * @param {{ workspace?: string, nameRegex?: string }} filters
	 */
	async function listSessions(filters = {}) {
		const headers = await loadSessionHeaders();
		const byPath = workspaceIndex();
		const workspaceFilter = typeof filters.workspace === "string" ? filters.workspace : "";
		const namePattern = typeof filters.nameRegex === "string" ? filters.nameRegex : "";
		let nameRe;
		if (namePattern !== "") {
			try {
				nameRe = new RegExp(namePattern);
			} catch (error) {
				throw apiError(400, "invalid_name_regex", `invalid name regex: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const workspaceMatched = [];
		for (const header of headers) {
			const cwd = canonicalizeSessionCwd(header.cwd);
			const workspace = byPath.get(cwd);
			const workspaceTitle = workspace?.title ?? "";
			if (!matchesWorkspaceFilter(cwd, workspaceTitle, workspaceFilter)) continue;
			workspaceMatched.push({
				id: header.id,
				cwd,
				workspaceTitle,
				agentPreset: typeof header.agentPreset === "string" ? header.agentPreset : "",
			});
		}

		const titleById = await loadTitles(workspaceMatched.map((entry) => entry.id));
		const data = [];
		for (const entry of workspaceMatched) {
			const name = titleById.get(entry.id) ?? "";
			if (nameRe !== undefined && !nameRe.test(name)) continue;
			data.push({
				dsh_session: entry.id,
				dsh_workspace: entry.cwd,
				name,
				agent_preset: entry.agentPreset,
			});
		}
		return data;
	}

	/**
	 * Ensure a live agent for rename (resume cold sessions when needed).
	 * Unlike openSession sticky resume, any durable session id is accepted.
	 */
	async function ensureLiveAgent(sessionId) {
		if (typeof sessionId !== "string" || sessionId === "") {
			throw apiError(400, "invalid_session", "session id is required");
		}
		if (typeof ctx.agents.get === "function") {
			const live = ctx.agents.get(sessionId);
			if (live !== undefined) return live;
		}
		try {
			const selection = defaultSelection();
			const { agent } = await ctx.agents.resume({
				resumeSessionId: SessionId(sessionId),
				agentOptions: agentOptions(selection),
				setup: makeSetup(selection, ""),
			});
			return agent;
		} catch (error) {
			throw apiError(404, "session_not_found", `cannot resume session: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Rename a session via the host sessionTitle service (pins user title).
	 * @returns {{ dsh_session: string, dsh_workspace: string, name: string }}
	 */
	async function renameSession(sessionId, name) {
		if (typeof name !== "string") {
			throw apiError(400, "invalid_title", "name must be a string");
		}
		const titleService = ctx.get("sessionTitle");
		if (titleService === undefined || typeof titleService.rename !== "function") {
			throw apiError(503, "rename_unavailable", "renaming is unavailable: sessionTitle service not mounted");
		}
		const agent = await ensureLiveAgent(sessionId);
		try {
			const accepted = titleService.rename(agent.session, name);
			flush(agent);
			return {
				dsh_session: String(agent.session.id ?? sessionId),
				dsh_workspace: sessionCwdOf(agent),
				name: accepted.title,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error?.name === "SessionTitleInvalidError" || /title must contain visible/i.test(message)) {
				throw apiError(400, "invalid_title", message);
			}
			throw error;
		}
	}

	function dispose() {
		stickyTouched.clear();
	}

	return {
		resolveModel,
		listModels,
		openSession,
		runTurn,
		flush,
		listSessions,
		renameSession,
		listPresets,
		dispose,
		defaultCwd,
	};
}

export { foldAssistantText, resolveCwd };
