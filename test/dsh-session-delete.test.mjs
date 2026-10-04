/**
 * Integration test for the `dsh-session-delete` Host half.
 *
 * Loads the real plugin module and drives the real HTTP handler through a fake
 * Cordis context and a fake DSH home, so the file moves are exercised end to end
 * without touching the user's store.
 *
 * Run: node test/dsh-session-delete.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN = pathToFileURL(join(HERE, '..', 'index.js')).href;
const HOME = join(HERE, '.tmp-test', 'home');

const SESSION_ID = 'session-00000000-0000-4000-8000-000000000000';
const PROJECT_DIR = '--proj--';

// The real home must never be a candidate during this test.
delete process.env.DSH_HOME;

/** Build a Node-request stand-in carrying one JSON body. */
function makeReq(method, body, headers = {}) {
	const payload = Buffer.from(body ?? '');
	return {
		method,
		headers: { host: '127.0.0.1:19387', 'content-type': 'application/json', ...headers },
		async *[Symbol.asyncIterator]() {
			yield payload;
		},
	};
}

/** Capture what the handler wrote. */
function makeRes() {
	return {
		statusCode: null,
		body: null,
		writeHead(code) {
			this.statusCode = code;
		},
		end(text) {
			this.body = text === void 0 ? null : String(text);
		},
	};
}

/** Wire the real plugin into a fake context and return the captured route handler. */
async function mount({ live = false, sessionsGet } = {}) {
	const { apply } = await import(PLUGIN);
	const routes = [];
	const sessions = sessionsGet ?? { get: (id) => (live ? { id } : void 0) };
	const scope = {
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
		get(name) {
			if (name === 'dshHomePath') return (segment) => join(HOME, segment);
			if (name === 'sessions') return sessions;
			return void 0;
		},
		logger: { warn() {} },
		effect(fn) {
			return fn();
		},
	};
	apply({ inject(_deps, callback) { callback(scope); } });
	assert.equal(routes.length, 1, 'expected exactly one registered route');
	return routes[0].handler;
}

/** Seed a session log directory plus its projection checkpoint. */
async function seed() {
	await rm(join(HERE, '.tmp-test'), { recursive: true, force: true });
	const sessionDir = join(HOME, 'sessions', PROJECT_DIR, SESSION_ID);
	await mkdir(sessionDir, { recursive: true });
	await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'fake-log', 'utf8');
	const cacheDir = join(HOME, 'storages', 'session_projcache', 'sessions');
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, `${SESSION_ID}.json`), JSON.stringify({ title: 'fake' }), 'utf8');
	return { sessionDir, cacheFile: join(cacheDir, `${SESSION_ID}.json`) };
}

const results = [];
async function test(name, fn) {
	try {
		await fn();
		results.push(`  PASS  ${name}`);
	} catch (error) {
		results.push(`  FAIL  ${name}\n        ${error.message}`);
		process.exitCode = 1;
	}
}

const url = '/dsh-session-delete/delete';

await test('rejects a non-POST request', async () => {
	const handler = await mount();
	const res = makeRes();
	await handler(makeReq('GET', null), res);
	assert.equal(res.statusCode, 405);
});

await test('rejects a cross-origin request', async () => {
	const handler = await mount();
	const res = makeRes();
	await handler(makeReq('POST', JSON.stringify({ sessionId: SESSION_ID }), { origin: 'https://evil.example' }), res);
	assert.equal(res.statusCode, 403);
});

await test('rejects a traversal-shaped session id', async () => {
	const handler = await mount();
	const res = makeRes();
	await handler(makeReq('POST', JSON.stringify({ sessionId: '../../etc' })), res);
	assert.equal(res.statusCode, 400);
});

await test('reports an unknown session as 404', async () => {
	const handler = await mount();
	const res = makeRes();
	await handler(makeReq('POST', JSON.stringify({ sessionId: SESSION_ID })), res);
	assert.equal(res.statusCode, 404);
	assert.equal(JSON.parse(res.body).code, 'unknown');
});

await test('refuses a live session and leaves the log in place', async () => {
	const { sessionDir } = await seed();
	const handler = await mount({ live: true });
	const res = makeRes();
	await handler(makeReq('POST', JSON.stringify({ sessionId: SESSION_ID })), res);
	assert.equal(res.statusCode, 409);
	const payload = JSON.parse(res.body);
	assert.equal(payload.code, 'active');
	assert.match(payload.message, /Cannot remove active session/);
	assert.equal(existsSync(sessionDir), true, 'a refusal must not touch the log');
	assert.equal(existsSync(join(HOME, 'session-trash')), false, 'a refusal must not create trash');
});

await test('re-checks liveness just before the move and refuses if it became live', async () => {
	const { sessionDir } = await seed();
	const sessionsGet = {
		count: 0,
		get() {
			this.count += 1;
			return this.count >= 2 ? { id: SESSION_ID } : void 0;
		},
	};
	const handler = await mount({ sessionsGet });
	const res = makeRes();
	await handler(makeReq('POST', JSON.stringify({ sessionId: SESSION_ID })), res);
	assert.equal(res.statusCode, 409);
	assert.equal(JSON.parse(res.body).code, 'active');
	assert.equal(existsSync(sessionDir), true, 'the log must stay when the re-check refuses');
});

await test('moves a cold session directory into <home>/session-trash and leaves the cache alone', async () => {
	const { sessionDir, cacheFile } = await seed();
	const handler = await mount();
	const res = makeRes();
	await handler(makeReq('POST', JSON.stringify({ sessionId: SESSION_ID })), res);
	assert.equal(res.statusCode, 200, res.body);
	const payload = JSON.parse(res.body);
	assert.equal(payload.ok, true);

	// The whole session directory left the persistence root.
	assert.equal(existsSync(sessionDir), false, 'session directory should be gone');
	const trashRoot = join(HOME, 'session-trash');
	const entries = await readdir(trashRoot);
	assert.equal(entries.length, 1, `expected one trash entry, got ${entries.join(',')}`);
	const entry = join(trashRoot, entries[0]);
	assert.equal(await readFile(join(entry, 'session', 'session.v4.jsonl.zstd'), 'utf8'), 'fake-log');
	const meta = JSON.parse(await readFile(join(entry, 'trash-meta.json'), 'utf8'));
	assert.equal(meta.sessionId, SESSION_ID);
	assert.equal(meta.from, sessionDir);

	// The projection cache is derived data and must stay where it was.
	assert.equal(existsSync(cacheFile), true, 'the projection cache must not be moved');
});

await test('does not overwrite an existing trash entry', async () => {
	const { sessionDir } = await seed();
	// Pre-create the exact entry the handler will target by freezing the clock.
	const RealDate = Date;
	const fixed = '2026-01-01T00-00-00-000Z';
	globalThis.Date = class extends RealDate {
		constructor(...args) {
			if (args.length === 0) super(fixed);
			else super(...args);
		}
		static now() {
			return new RealDate(fixed).getTime();
		}
		toISOString() {
			return fixed;
		}
	};
	try {
		const entry = join(HOME, 'session-trash', `${fixed}__${SESSION_ID}`);
		await mkdir(join(entry, 'session'), { recursive: true });
		await writeFile(join(entry, 'session', 'session.v4.jsonl.zstd'), 'existing', 'utf8');

		const handler = await mount();
		const res = makeRes();
		await handler(makeReq('POST', JSON.stringify({ sessionId: SESSION_ID })), res);
		assert.equal(res.statusCode, 409);
		assert.equal(JSON.parse(res.body).code, 'conflict');
		assert.equal(existsSync(sessionDir), true, 'the source must stay when the target exists');
		assert.equal(await readFile(join(entry, 'session', 'session.v4.jsonl.zstd'), 'utf8'), 'existing');
	} finally {
		globalThis.Date = RealDate;
	}
});

console.log('\ndsh-session-delete host tests');
console.log(results.join('\n'));
console.log(process.exitCode === 1 ? '\nFAILED\n' : '\nall passed\n');
