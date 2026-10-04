#!/usr/bin/env node
/**
 * `dsh-session-delete` 保留目录的命令行管理工具。
 *
 * 插件删除会话时只是把文件**移动**到保留目录里的 `<时间戳>__<会话 id>/`，
 * 不走 Windows 回收站、也不抹除任何东西。这个脚本让你不用碰文件管理器就能
 * 查看、还原和彻底清空那些条目。
 *
 * 保留目录的位置按此顺序解析，保证与插件永远一致：
 *   1. `--dir <路径>`
 *   2. 环境变量 `DSH_SESSION_TRASH_DIR`
 *   3. 插件 bundle patch（`dsh-session-delete/cordis.patch.yml`）里的 `trashDir`
 *   4. 回退：`<DSH home>/session-trash`
 *
 * 用法（在插件目录下运行）：
 *   node bin/session-trash.mjs list
 *   node bin/session-trash.mjs restore <序号|会话 id>
 *   node bin/session-trash.mjs purge   <序号|会话 id> --yes
 *   node bin/session-trash.mjs purge   --all --yes
 */
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The DSH home: `$DSH_HOME` first, then the platform default. */
function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
	return join(homedir(), '.dsh');
}

/** Read `trashDir` out of the plugin's bundle patch, so both sides agree by construction. */
function trashDirFromPatch() {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const patch = join(here, '..', 'cordis.patch.yml');
		const matched = readFileSync(patch, 'utf8').match(/^\s*trashDir:\s*'([^']+)'\s*$/m);
		if (matched !== null && matched[1].trim().length > 0) return matched[1].trim();
	} catch {
		/* the patch is optional */
	}
	return null;
}

/** The `--dir` flag, if given. */
function dirFromArgv() {
	const index = process.argv.indexOf('--dir');
	if (index === -1) return null;
	const value = process.argv[index + 1];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

const TRASH = dirFromArgv() ?? process.env.DSH_SESSION_TRASH_DIR ?? trashDirFromPatch() ?? join(dshHome(), 'session-trash');

/** Read every trash entry, newest last. */
async function readEntries() {
	if (!existsSync(TRASH)) return [];
	const names = (await readdir(TRASH, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const entries = [];
	for (const name of names) {
		const dir = join(TRASH, name);
		let meta = {};
		try {
			meta = JSON.parse(readFileSync(join(dir, 'trash-meta.json'), 'utf8'));
		} catch {
			/* an entry without metadata is still listed, just without provenance */
		}
		let title = null;
		try {
			const cache = JSON.parse(readFileSync(join(dir, 'projection-cache.json'), 'utf8'));
			title = cache?.record?.rows?.title?.val ?? null;
		} catch {
			/* no cached title */
		}
		let bytes = 0;
		const sessionDir = join(dir, 'session');
		if (existsSync(sessionDir)) {
			for (const file of await readdir(sessionDir)) {
				try {
					bytes += (await stat(join(sessionDir, file))).size;
				} catch {
					/* skip */
				}
			}
		}
		entries.push({
			dir,
			name,
			sessionId: meta.sessionId ?? name.split('__').pop(),
			deletedAt: meta.deletedAt ?? null,
			from: meta.from ?? null,
			title,
			bytes,
			restorable: typeof meta.from === 'string' && existsSync(sessionDir),
		});
	}
	return entries;
}

/** Resolve an argument that is either a 1-based index or a session id. */
function resolve(entries, selector) {
	if (/^\d+$/.test(selector)) {
		const entry = entries[Number(selector) - 1];
		if (entry === void 0) throw new Error(`没有第 ${selector} 条（共 ${entries.length} 条）`);
		return entry;
	}
	const matches = entries.filter((entry) => entry.sessionId === selector || entry.sessionId?.includes(selector));
	if (matches.length === 0) throw new Error(`找不到匹配「${selector}」的条目`);
	if (matches.length > 1) throw new Error(`「${selector}」匹配到 ${matches.length} 条，请用完整会话 id`);
	return matches[0];
}

/** Move a path, falling back to copy+remove across devices. */
async function move(from, to) {
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
}

async function cmdList() {
	const entries = await readEntries();
	console.log(`保留目录：${TRASH}`);
	if (entries.length === 0) {
		console.log('\n（空）');
		return;
	}
	console.log(`共 ${entries.length} 条\n`);
	entries.forEach((entry, index) => {
		const when = entry.deletedAt === null ? '时间未知' : new Date(entry.deletedAt).toLocaleString();
		console.log(`${index + 1}. ${entry.title ?? '(无缓存标题)'}`);
		console.log(`   会话 id  ${entry.sessionId}`);
		console.log(`   删除于   ${when}`);
		console.log(`   占用     ${entry.bytes.toLocaleString()} 字节`);
		console.log(`   原位置   ${entry.from ?? '(未知)'}`);
		if (!entry.restorable) console.log('   ⚠ 会话目录缺失，无法还原');
		console.log('');
	});
	console.log('还原：node session-trash.mjs restore <序号>');
	console.log('清空：node session-trash.mjs purge <序号> --yes');
}

async function cmdRestore(selector) {
	const entries = await readEntries();
	const entry = resolve(entries, selector);
	if (typeof entry.from !== 'string') throw new Error('该条目没有记录原位置，无法自动还原');
	if (existsSync(entry.from)) throw new Error(`目标位置已存在内容，请先处理：${entry.from}`);
	await move(join(entry.dir, 'session'), entry.from);
	// Keep the trash entry's remaining bookkeeping for audit, minus the moved log.
	console.log(`已还原「${entry.title ?? entry.sessionId}」`);
	console.log(`  → ${entry.from}`);
	console.log('\n重启 DSH 后它才会重新出现在侧栏。');
}

async function cmdPurge(selectors, all) {
	const entries = await readEntries();
	const targets = all ? entries : selectors.map((selector) => resolve(entries, selector));
	if (targets.length === 0) throw new Error('没有要清空的条目');
	for (const entry of targets) {
		await rm(entry.dir, { recursive: true, force: true });
		console.log(`已彻底删除「${entry.title ?? entry.sessionId}」（${entry.bytes.toLocaleString()} 字节）`);
	}
	console.log('\n以上内容已从磁盘抹除，无法恢复。');
}

const [command, ...rest] = process.argv.slice(2);
const flagAll = rest.includes('--all');
const flagYes = rest.includes('--yes');
// `--dir <path>` carries a value, so its argument is not a selector.
const dirFlagIndex = rest.indexOf('--dir');
const selectors = rest.filter(
	(argument, index) =>
		!argument.startsWith('--') && !(dirFlagIndex !== -1 && index === dirFlagIndex + 1),
);

try {
	switch (command) {
		case 'list':
		case void 0:
			await cmdList();
			break;
		case 'restore':
			if (selectors.length !== 1) throw new Error('restore 需要一个序号或会话 id');
			await cmdRestore(selectors[0]);
			break;
		case 'purge':
			if (!flagYes) {
				console.log('purge 会从磁盘抹除内容，不可恢复。确认请加 --yes。');
				console.log('先看看有什么：node session-trash.mjs list');
				process.exitCode = 1;
				break;
			}
			if (!flagAll && selectors.length === 0) throw new Error('purge 需要序号/会话 id，或 --all');
			await cmdPurge(selectors, flagAll);
			break;
		default:
			console.log('未知命令。可用：list | restore <序号|会话 id> | purge <序号|会话 id> --yes | purge --all --yes');
			process.exitCode = 1;
	}
} catch (error) {
	console.error(`错误：${error?.message ?? error}`);
	process.exitCode = 1;
}
