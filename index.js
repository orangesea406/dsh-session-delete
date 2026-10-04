/**
 * Host half of `dsh-session-delete`.
 *
 * Deletes a **cold** session by moving its whole session directory out of the
 * persistence root and into a trash directory that is a sibling of `sessions/`
 * under the DSH home (`<DSH_HOME>/session-trash/`). Nothing is erased: the
 * artifact stays intact, so it can be recovered by hand.
 *
 * ## Why a move is enough
 *
 * The UI list is built from `sessionPersistence.list()`, which scans the
 * `sessions/` root two levels deep (`root/<project>/<session>/session.vN.jsonl.zstd`).
 * Once the directory is no longer under that root, `list()` does not return it,
 * so `sessionQuery.listSessions()` (persisted ∪ live) drops the row and the UI
 * list no longer shows it. `workspace.json` needs no write: its stale
 * `sessionIds` entry is filtered by `WorkspaceEntity.sessionIds` (which keys on
 * the header-derived path index) and skipped by the client's workspace grouping
 * when no summary exists. The projection cache and attachments are derived or
 * content-addressed and are left untouched.
 *
 * ## Why only cold sessions
 *
 * A live session is held in memory by `ctx.sessions`, and `listSessions()`
 * merges every live session unconditionally, so moving its files would not make
 * it disappear. Worse, the open write handle would recreate a header-less log
 * at the derived path on its next append. This plugin therefore refuses any
 * session the Host still holds and asks the user to close it first.
 *
 * The move is a pure `fs.rename` (with a copy-then-remove fallback across
 * devices), so it can never silently become a permanent delete.
 *
 * @module dsh-session-delete
 */
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Exact HTTP route the browser half posts to. */
const ROUTE = '/dsh-session-delete/delete';

/** Trash root under the DSH home; a sibling of `sessions/` so no backend scans it. */
const TRASH_SEGMENT = 'session-trash';

/** Session ids this plugin accepts. The charset excludes `.`, `/` and `\`, so an id can never traverse. */
const SESSION_ID = /^session-[A-Za-z0-9-]{1,80}$/;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/**
 * Encode one session id into its path segment, mirroring the JSONL backend's
 * `encodeSegment`: `[A-Za-z0-9._-]` survive except `~`, everything else becomes
 * a `~XXXX` escape. Kept in sync deliberately — the fallback scan below exists
 * precisely because this could drift.
 *
 * @param id - Session id.
 * @returns the directory segment the backend would use.
 */
function encodeSegment(id) {
	let out = '';
	for (let i = 0; i < id.length; i += 1) {
		const code = id.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
	}
	return out;
}

/**
 * Every DSH home this process could plausibly be using, most authoritative
 * first. `ctx.dshHomePath` is provided by app boot and is the real answer; the
 * environment and the platform default only cover a Host that did not provide
 * it.
 *
 * @param ctx - Plugin context.
 * @returns candidate home directories.
 */
function candidateHomes(ctx) {
	const homes = [];
	try {
		const homePath = ctx.get('dshHomePath');
		if (typeof homePath === 'function') homes.push(dirname(homePath('sessions')));
	} catch {
		/* an unavailable optional service is not a failure */
	}
	if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
		homes.push(process.env.DSH_HOME);
	}
	homes.push(join(homedir(), '.dsh'));
	return [...new Set(homes)];
}

/**
 * Read the request body as UTF-8 text with a hard cap.
 *
 * @param req - Node request.
 * @returns the decoded body.
 */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > 64 * 1024) throw new Error('request body too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * The same-origin fence for a destructive route. The webserver itself carries no
 * origin policy, so a page the user happens to have open must not be able to
 * delete sessions; `connection.requestRejection` is the Host's own trusted-host
 * check and is preferred when present.
 *
 * @param ctx - Plugin context.
 * @param req - Node request.
 * @returns a rejection status code, or `null` to allow the request.
 */
function rejectUnsafe(ctx, req) {
	if (req.method !== 'POST') return 405;
	const origin = req.headers.origin;
	if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
		let originHost;
		try {
			originHost = new URL(origin).host;
		} catch {
			return 403;
		}
		const host = req.headers.host;
		const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
		if (!loopback.test(originHost) || (typeof host === 'string' && host.length > 0 && originHost !== host)) {
			return 403;
		}
	}
	try {
		const connection = ctx.get('connection');
		if (connection !== void 0 && typeof connection.requestRejection === 'function') {
			const code = connection.requestRejection(req);
			if (code !== void 0 && code !== null && code !== false) {
				return typeof code === 'number' ? code : 403;
			}
		}
	} catch {
		return 403;
	}
	return null;
}

/**
 * Locate the on-disk session directory for one id.
 *
 * The backend stores `<root>/<project-key>/<encoded-id>/`; the project key
 * derives from the session's recorded cwd, which this plugin deliberately does
 * not recompute. Scanning the root's project directories for the encoded
 * segment is both simpler and immune to that derivation changing.
 *
 * @param home - DSH home directory.
 * @param id - Session id.
 * @returns the absolute session directory, or `undefined` when nothing matches.
 */
async function findSessionDir(home, id) {
	const encoded = encodeSegment(id);
	const root = join(home, 'sessions');
	let projects;
	try {
		projects = await readdir(root, { withFileTypes: true });
	} catch {
		return void 0;
	}
	const dirs = projects.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	for (const project of ['_no-cwd', ...dirs.filter((name) => name !== '_no-cwd')]) {
		const candidate = join(root, project, encoded);
		try {
			if ((await stat(candidate)).isDirectory()) return candidate;
		} catch {
			/* keep looking */
		}
	}
	// Fallback: a directory whose name merely contains the id (drifted encoding).
	for (const project of dirs) {
		let entries;
		try {
			entries = await readdir(join(root, project), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.includes(id)) return join(root, project, entry.name);
		}
	}
	return void 0;
}

/**
 * Move a path into the trash, falling back to copy-then-remove across devices.
 *
 * @param from - Existing source path.
 * @param to - Destination inside the trash entry.
 * @returns the destination path.
 */
async function moveToTrash(from, to) {
	await mkdir(dirname(to), { recursive: true });
	try {
		await rename(from, to);
	} catch (error) {
		if (error !== null && typeof error === 'object' && error.code === 'EXDEV') {
			await cp(from, to, { recursive: true });
			await rm(from, { recursive: true, force: true });
		} else {
			throw error;
		}
	}
	return to;
}

/**
 * Whether the Host still holds this session in memory. A live session is immune
 * to file-level deletion and would recreate a header-less log on its next
 * append, so it is refused outright.
 *
 * @param ctx - Plugin context.
 * @param id - Session id.
 * @returns `true` when `ctx.sessions` still holds the session.
 */
function isLive(ctx, id) {
	try {
		const sessions = ctx.get('sessions');
		return sessions !== void 0 && typeof sessions.get === 'function' && sessions.get(id) !== void 0;
	} catch {
		return false;
	}
}

/**
 * Whether a filesystem path exists.
 *
 * @param path - Path to test.
 * @returns `true` when `stat` resolves.
 */
async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The active-session refusal the browser half renders verbatim.
 *
 * @param id - Session id.
 * @returns the HTTP result.
 */
function activeRefusal(id) {
	return {
		status: 409,
		body: {
			ok: false,
			code: 'active',
			sessionId: id,
			message: 'Cannot remove active session. Close the session first.',
		},
	};
}

/**
 * Compose the deletion for one cold session: find its directory, then move the
 * whole directory into `<home>/session-trash/<stamp>__<id>/session`.
 *
 * @param ctx - Plugin context.
 * @param id - Session id to delete.
 * @returns the JSON payload for the browser half.
 */
async function deleteSession(ctx, id) {
	if (isLive(ctx, id)) return activeRefusal(id);

	const homes = candidateHomes(ctx);
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	for (const home of homes) {
		const sessionDirectory = await findSessionDir(home, id);
		if (sessionDirectory === void 0) continue;

		// Re-check just before the move: the session may have been attached while
		// the directory scan ran.
		if (isLive(ctx, id)) return activeRefusal(id);

		const entry = join(home, TRASH_SEGMENT, `${stamp}__${id}`);
		const destination = join(entry, 'session');
		if (await pathExists(destination)) {
			return { status: 409, body: { ok: false, code: 'conflict', sessionId: id } };
		}
		await mkdir(entry, { recursive: true });
		await writeFile(
			join(entry, 'trash-meta.json'),
			`${JSON.stringify({ sessionId: id, deletedAt: new Date().toISOString(), from: sessionDirectory }, null, 2)}\n`,
			'utf8',
		);
		await moveToTrash(sessionDirectory, destination);
		return { status: 200, body: { ok: true, sessionId: id, trashed: [destination] } };
	}
	return { status: 404, body: { ok: false, code: 'unknown', sessionId: id } };
}

/**
 * Mount the Host half.
 *
 * @param ctx - Plugin context.
 */
export function apply(ctx) {
	ctx.inject(['webServer'], (scope) => {
		scope.effect(
			() =>
				scope.webServer.register({
					kind: 'exact',
					path: ROUTE,
					handler: async (req, res) => {
						const reply = (status, payload) => {
							res.writeHead(status, JSON_HEADERS);
							res.end(JSON.stringify(payload));
						};
						const rejection = rejectUnsafe(scope, req);
						if (rejection !== null) {
							reply(rejection, { ok: false, code: 'forbidden' });
							return;
						}
						try {
							const parsed = JSON.parse((await readBody(req)) || '{}');
							const id = parsed?.sessionId;
							if (typeof id !== 'string' || !SESSION_ID.test(id)) {
								reply(400, { ok: false, code: 'invalid-session-id' });
								return;
							}
							const { status, body } = await deleteSession(scope, id);
							reply(status, body);
						} catch (error) {
							scope.logger?.warn?.(`session-delete: ${String(error)}`);
							reply(500, { ok: false, code: 'internal', message: String(error?.message ?? error) });
						}
					},
				}),
			'dsh-session-delete: route',
		);
	});
}
