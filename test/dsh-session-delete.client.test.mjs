/**
 * Smoke test for the `dsh-session-delete` browser half.
 *
 * There is no browser here, so this drives the real `client.js` through a
 * minimal `window.__ModuleLoader__` facade, a React stand-in, and a fake Cordis
 * context. It cannot prove how the entry looks in the running page; it does
 * prove the module registers the two entries it claims, with the slot options
 * and inject faces the host expects, and that the confirmation flow reacts to
 * every response shape the Host produces.
 *
 * Run: node test/dsh-session-delete.client.test.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT = pathToFileURL(join(HERE, '..', 'client.js')).href;

/** A React stand-in: elements are plain objects, hooks run inline. */
const React = {
	createElement(type, props, ...children) {
		return { type, props: { ...(props ?? {}), children: children.flat() } };
	},
	useState(initial) {
		return [typeof initial === 'function' ? initial() : initial, () => {}];
	},
	useEffect(fn) {
		const cleanup = fn();
		if (typeof cleanup === 'function') cleanup();
	},
	useMemo(fn) {
		return fn();
	},
};

/** Collect every node in an element tree, including text leaves. */
function flatten(node, out = []) {
	if (node === null || node === void 0 || node === false) return out;
	if (Array.isArray(node)) {
		for (const child of node) flatten(child, out);
		return out;
	}
	if (typeof node !== 'object') {
		out.push(node);
		return out;
	}
	out.push(node);
	flatten(node.props?.children, out);
	return out;
}

/** All text under a node. */
function textOf(node) {
	return flatten(node)
		.filter((entry) => typeof entry === 'string')
		.join('');
}

/** First node matching a predicate. */
function find(node, predicate) {
	return flatten(node).find((entry) => typeof entry === 'object' && entry !== null && predicate(entry));
}

// ---- environment stubs -----------------------------------------------------

const styleElements = [];
globalThis.window = {
	__ModuleLoader__: {
		loaded: null,
		load(spec) {
			this.loaded = spec;
		},
	},
};
globalThis.document = {
	documentElement: { lang: 'zh-CN' },
	head: { appendChild: (element) => styleElements.push(element) },
	createElement: (tag) => ({
		tag,
		id: '',
		textContent: '',
		parentNode: null,
	}),
	getElementById: (id) => styleElements.find((element) => element.id === id) ?? null,
};
// Node defines `navigator` as a getter-only global; the client only reads `language`.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

// A Storage-like facade. A browser `localStorage` surfaces its entries as own
// enumerable properties, which is exactly what the client's `Object.keys` walk
// relies on, so this stub must behave the same way rather than exposing methods.
const storageEntries = new Map();
globalThis.localStorage = new Proxy(
	{},
	{
		get(_target, prop) {
			if (prop === 'getItem') return (key) => (storageEntries.has(String(key)) ? storageEntries.get(String(key)) : null);
			if (prop === 'setItem') return (key, value) => void storageEntries.set(String(key), String(value));
			if (prop === 'removeItem') return (key) => void storageEntries.delete(String(key));
			if (prop === 'clear') return () => storageEntries.clear();
			if (prop === 'key') return (index) => [...storageEntries.keys()][index] ?? null;
			if (prop === 'length') return storageEntries.size;
			return storageEntries.has(prop) ? storageEntries.get(prop) : void 0;
		},
		has(_target, prop) {
			return prop === 'length' || storageEntries.has(prop);
		},
		ownKeys() {
			return [...storageEntries.keys()];
		},
		getOwnPropertyDescriptor(_target, prop) {
			if (storageEntries.has(prop)) {
				return { value: storageEntries.get(prop), enumerable: true, configurable: true, writable: true };
			}
			return void 0;
		},
	},
);

await import(CLIENT);

const loader = globalThis.window.__ModuleLoader__.loaded;
assert.ok(loader, 'client.js must call window.__ModuleLoader__.load');
assert.equal(loader.id, 'dsh-session-delete', 'the factory id must equal the package name');

const plugin = loader.factory((name) => {
	if (name === 'react') return React;
	throw new Error(`unexpected external: ${name}`);
});
assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions']);
assert.equal(typeof plugin.apply, 'function');

// ---- mount ------------------------------------------------------------------

const registrations = [];
const locales = [];
let refreshCalls = 0;
const ctx = {
	effect(fn) {
		return fn();
	},
	locale: {
		register(namespace, dictionaries) {
			locales.push({ namespace, dictionaries });
			return () => {};
		},
	},
	slots: {
		inject(owner, callback) {
			assert.ok(owner === 'sidebar.workspaces.session.menu.item' || owner === 'shell.overlay');
			callback();
			return () => {};
		},
		register(options, component) {
			registrations.push({ options, component });
			return () => {};
		},
	},
	sessions: {
		refresh() {
			refreshCalls += 1;
		},
	},
};

plugin.apply(ctx);

const menuRegistration = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item');
const overlayRegistration = registrations.find((entry) => entry.options.name === 'shell.overlay');

const results = [];
function check(name, fn) {
	try {
		fn();
		results.push(`  PASS  ${name}`);
	} catch (error) {
		results.push(`  FAIL  ${name}\n        ${error.message}`);
		process.exitCode = 1;
	}
}

check('registers the row menu entry after the shipped Archive action', () => {
	assert.ok(menuRegistration, 'missing sidebar.workspaces.session.menu.item registration');
	assert.equal(menuRegistration.options.id, 'dsh.session-delete');
	assert.equal(menuRegistration.options.order, 500);
	assert.equal(menuRegistration.options.locale, 'dshSessionDelete');
	assert.equal(typeof menuRegistration.options.inject, 'function');
});

check('registers the confirmation into shell.overlay', () => {
	assert.ok(overlayRegistration, 'missing shell.overlay registration');
	assert.equal(overlayRegistration.options.id, 'dsh.session-delete.dialog');
});

check('registers its locale namespace and injects its stylesheet once', () => {
	assert.equal(locales.length, 1);
	assert.equal(locales[0].namespace, 'dshSessionDelete');
	assert.ok(locales[0].dictionaries.zh['menu.delete'] === '删除会话');
	assert.ok(locales[0].dictionaries.en['menu.delete'] === 'Delete session');
	assert.equal(styleElements.length, 1);
	assert.match(styleElements[0].textContent, /dsh-session-delete-overlay/);
});

check('names the Harness trash folder, not the Windows Recycle Bin', () => {
	const copy = locales[0].dictionaries.zh['dialog.where'];
	assert.ok(copy.includes('session-trash'), copy);
	assert.ok(copy.includes('不是 Windows 回收站'), copy);
	assert.ok(locales[0].dictionaries.en['dialog.where'].includes('not the Windows Recycle Bin'));
	assert.equal(locales[0].dictionaries.zh['dialog.confirm'], '删除（可恢复）');
});

check('renders a role="menuitem" row that closes the menu and requests the dialog', () => {
	const requested = [];
	const closed = [];
	const face = menuRegistration.options.inject();
	// One injected face is shared by every row, so the request lands per click.
	const element = menuRegistration.component({
		...face,
		sessionId: 'session-abc',
		displayTitle: '示例会话',
		useMenuOpenState: () => [true, (value) => closed.push(value)],
		requestDelete: (id, title) => requested.push([id, title]),
	});
	const button = find(element, (node) => node.type === 'button');
	assert.ok(button, 'expected a button');
	assert.equal(button.props.role, 'menuitem');
	assert.equal(textOf(button).includes('删除会话'), true, `label was ${textOf(button)}`);
	button.props.onClick();
	assert.deepEqual(closed, [false], 'the menu must close on select');
	assert.deepEqual(requested, [['session-abc', '示例会话']]);
});

check('renders nothing while no confirmation is pending', () => {
	const element = overlayRegistration.component({ t: undefined });
	assert.equal(element, null);
});

/** Drive the dialog through one Host response. */
async function runDialog(responses) {
	const queue = [...responses];
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, body: JSON.parse(init.body) });
		const next = queue.shift();
		return { ok: next.ok, status: next.status, json: async () => next.body };
	};
	const face = menuRegistration.options.inject();
	const props = { t: undefined, ...face };
	face.requestDelete('session-abc', '示例会话');
	let element = overlayRegistration.component(props);
	return {
		calls,
		element,
		rerender: () => {
			element = overlayRegistration.component(props);
			return element;
		},
	};
}

await (async () => {
	refreshCalls = 0;
	const { calls, rerender } = await runDialog([{ ok: true, status: 200, body: { ok: true, sessionId: 'session-abc' } }]);
	const element = overlayRegistration.component({ t: undefined, ...menuRegistration.options.inject() });

	check('renders the confirmation with the session title and trash location', () => {
		assert.ok(element, 'expected a dialog');
		const text = textOf(element);
		assert.ok(text.includes('删除此会话？'), text);
		assert.ok(text.includes('示例会话'), text);
		assert.ok(text.includes('session-trash'), text);
	});

	await find(element, (node) => node.type === 'button' && node.props.className === 'dsh-session-delete-danger')
		.props.onClick();
	await new Promise((resolve) => setTimeout(resolve, 0));

	check('sends only the session id and closes on success', () => {
		assert.deepEqual(calls[0], {
			url: '/dsh-session-delete/delete',
			body: { sessionId: 'session-abc' },
		});
		assert.equal(rerender(), null, 'the dialog must close after a successful delete');
	});

	check('refreshes the Session list on success', () => {
		assert.equal(refreshCalls, 1, 'the Host list refresh must run exactly once');
	});
})();

await (async () => {
	const { calls, rerender } = await runDialog([
		{ ok: false, status: 409, body: { ok: false, code: 'active', message: 'Cannot remove active session. Close the session first.' } },
	]);
	const element = overlayRegistration.component({ t: undefined, ...menuRegistration.options.inject() });
	await find(element, (node) => node.type === 'button' && node.props.className === 'dsh-session-delete-danger').props.onClick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const next = rerender();

	check('explains a live session instead of retrying', () => {
		assert.ok(next !== null, 'the dialog must stay open for a live session');
		const text = textOf(next);
		assert.ok(text.includes('无法删除运行中的会话'), text);
		const buttons = flatten(next).filter((node) => node.type === 'button');
		assert.equal(buttons.length, 1, 'the only action left is Close');
		assert.equal(textOf(buttons[0]), '关闭');
		assert.deepEqual(calls[0], {
			url: '/dsh-session-delete/delete',
			body: { sessionId: 'session-abc' },
		});
	});
})();

await (async () => {
	const { rerender } = await runDialog([{ ok: false, status: 500, body: { ok: false, code: 'internal', message: 'boom' } }]);
	const element = overlayRegistration.component({ t: undefined, ...menuRegistration.options.inject() });
	await find(element, (node) => node.type === 'button' && node.props.className === 'dsh-session-delete-danger').props.onClick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	check('surfaces a Host failure instead of closing', () => {
		const next = rerender();
		assert.ok(next !== null, 'the dialog must stay open');
		assert.ok(textOf(next).includes('boom'), textOf(next));
	});
})();

await (async () => {
	// The Host settles only its own stores; the browser owns per-session UI state.
	// Seed the keys the app actually writes, plus one bystander to prove the
	// sweep is scoped to the deleted id.
	localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'session-abc' }));
	localStorage.setItem('dsh.conversation.session-abc', '{"scroll":0}');
	localStorage.setItem('dsh.sidebar-right.v1.session-abc', '{"minted":1}');
	localStorage.setItem('dsh.user-questions.drafts.v1.session-abc', 'draft text');
	localStorage.setItem('dsh.workspace.view.v5', '{"groupBy":"workspace"}');
	localStorage.setItem('dsh.unrelated', 'keep-me');

	const { rerender } = await runDialog([{ ok: true, status: 200, body: { ok: true, sessionId: 'session-abc' } }]);
	const element = overlayRegistration.component({ t: undefined, ...menuRegistration.options.inject() });
	await find(element, (node) => node.type === 'button' && node.props.className === 'dsh-session-delete-danger').props.onClick();
	await new Promise((resolve) => setTimeout(resolve, 0));

	check('clears the deleted session from browser localStorage and spares other keys', () => {
		assert.equal(localStorage.getItem('dsh.conversation.session-abc'), null, 'conversation view must go');
		assert.equal(localStorage.getItem('dsh.sidebar-right.v1.session-abc'), null, 'sidebar layout must go');
		assert.equal(localStorage.getItem('dsh.user-questions.drafts.v1.session-abc'), null, 'draft must go');
		assert.equal(localStorage.getItem('dsh.sessions.current'), null, 'the id-bearing current pointer must go');
		assert.equal(localStorage.getItem('dsh.workspace.view.v5'), '{"groupBy":"workspace"}', 'unrelated keys must survive');
		assert.equal(localStorage.getItem('dsh.unrelated'), 'keep-me', 'unrelated keys must survive');
		assert.equal(rerender(), null, 'the dialog must still close on success');
	});
})();

console.log('\ndsh-session-delete client smoke test');
console.log(results.join('\n'));
console.log(process.exitCode === 1 ? '\nFAILED\n' : '\nall passed\n');
