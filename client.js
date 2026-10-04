/**
 * Browser half of `dsh-session-delete`.
 *
 * Registers two entries:
 *  - a row in `sidebar.workspaces.session.menu.item` (the session "⋯" menu), and
 *  - a dialog in the app-wide `shell.overlay` list, so the confirmation outlives
 *    the menu that opened it.
 *
 * The two share one module-scope store: the menu entry only *requests* a
 * deletion, and the overlay entry owns the confirmation and the request.
 *
 * The Host moves the artifact and refuses a live session; this half only asks,
 * reports the refusal, and refreshes the Session list on success so the row
 * disappears immediately.
 *
 * Only `react` is required — the host's module table is the baseline, and this
 * plugin deliberately does not import Harness Client packages, so a renamed or
 * moved primitive cannot blank the slot.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const NS = 'dshSessionDelete';
		const ROUTE = '/dsh-session-delete/delete';
		const STYLE_ID = 'dsh-session-delete-styles';

		const en = {
			'menu.delete': 'Delete session',
			'dialog.title': 'Delete this session?',
			'dialog.body':
				'The conversation log of “{title}” is moved into the Harness trash folder, outside the sessions root. Nothing is erased, so it can still be recovered from disk.',
			'dialog.where': 'Saved in the Harness trash folder (not the Windows Recycle Bin).',
			'dialog.active.title': 'Cannot delete a running session',
			'dialog.active.body': 'Close the session first, then delete it.',
			'dialog.cancel': 'Cancel',
			'dialog.confirm': 'Delete (recoverable)',
			'dialog.pending': 'Deleting…',
			'dialog.failed': 'Deletion failed: {message}',
			'dialog.close': 'Close',
		};
		const zh = {
			'menu.delete': '删除会话',
			'dialog.title': '删除此会话？',
			'dialog.body':
				'「{title}」的对话日志会被移入 Harness 的回收目录（位于 sessions 根目录之外）。文件不会被抹除，之后仍可从磁盘恢复。',
			'dialog.where': '文件保存在 Harness 的 session-trash 目录（不是 Windows 回收站）。',
			'dialog.active.title': '无法删除运行中的会话',
			'dialog.active.body': '请先关闭该会话，再删除。',
			'dialog.cancel': '取消',
			'dialog.confirm': '删除（可恢复）',
			'dialog.pending': '正在删除…',
			'dialog.failed': '删除失败：{message}',
			'dialog.close': '关闭',
		};

		/** The Host's Session-list refresh, wired in `apply`; a no-op before that. */
		let refreshSessions = () => {};

		/** Fill `{name}` placeholders; used only when the locale service is unavailable. */
		function interpolate(text, params) {
			if (params === void 0) return text;
			return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
		}

		function localize(key, params) {
			const lang = String(
				(globalThis.document && globalThis.document.documentElement && globalThis.document.documentElement.lang) ||
					(globalThis.navigator && globalThis.navigator.language) ||
					'zh',
			).toLowerCase();
			const dict = lang.startsWith('zh') ? zh : en;
			return interpolate(dict[key] ?? en[key] ?? key, params);
		}

		const CSS = `
.dsh-session-delete-item{display:flex;align-items:center;width:100%;box-sizing:border-box;
  padding:6px 10px;border:0;border-radius:6px;background:transparent;cursor:pointer;text-align:left;
  font:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-text-primary,#1f1f1f)}
.dsh-session-delete-item:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.06))}
.dsh-session-delete-overlay{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.32)}
.dsh-session-delete-panel{box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 64px);
  overflow:auto;padding:20px;border-radius:12px;background:var(--dsw-alias-bg-elevated,#fff);
  color:var(--dsw-alias-text-primary,#1f1f1f);border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.12));
  box-shadow:0 12px 32px rgba(0,0,0,.18);font:inherit;font-size:13px;line-height:20px}
.dsh-session-delete-panel h2{margin:0 0 12px;font-size:15px;line-height:22px;font-weight:600}
.dsh-session-delete-panel p{margin:0 0 10px;color:var(--dsw-alias-text-secondary,#5c5c5c)}
.dsh-session-delete-warn{margin:0 0 10px;padding:10px 12px;border-radius:8px;
  background:var(--dsw-alias-bg-warning,rgba(255,166,0,.12));color:var(--dsw-alias-text-primary,#1f1f1f)}
.dsh-session-delete-warn strong{display:block;margin-bottom:4px;font-weight:600}
.dsh-session-delete-error{margin:0 0 10px;color:var(--dsw-alias-text-error,#c62828)}
.dsh-session-delete-path{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-session-delete-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.dsh-session-delete-actions button{padding:6px 14px;border-radius:8px;cursor:pointer;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.16));background:transparent;
  color:var(--dsw-alias-text-primary,#1f1f1f)}
.dsh-session-delete-actions button:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.06))}
.dsh-session-delete-actions button[disabled]{opacity:.55;cursor:default}
.dsh-session-delete-danger{border-color:transparent!important;
  background:var(--dsw-alias-bg-error,#c62828)!important;color:#fff!important}
.dsh-session-delete-danger:hover{filter:brightness(1.06)}
`;

		/** One pending confirmation, shared by the menu entry and the overlay entry. */
		const dialog = {
			state: null,
			listeners: new Set(),
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			},
			get() {
				return this.state;
			},
			set(next) {
				this.state = next;
				for (const listener of [...this.listeners]) listener();
			},
		};

		function useDialogState() {
			const [, bump] = React.useState(0);
			React.useEffect(() => dialog.subscribe(() => bump((n) => n + 1)), []);
			return dialog.get();
		}

		/** The "⋯" menu row: it only requests the dialog. */
		function DeleteMenuItem(props) {
			const { sessionId, displayTitle, requestDelete } = props;
			const t = props.t;
			// The hook must run during render; the setter is what the click uses.
			const closeMenu = React.useMemo(() => {
				try {
					if (typeof props.useMenuOpenState !== 'function') return () => {};
					const setMenuOpen = props.useMenuOpenState()[1];
					return typeof setMenuOpen === 'function' ? setMenuOpen : () => {};
				} catch {
					return () => {};
				}
			}, [props.useMenuOpenState]);
			const tr = React.useMemo(() => {
				if (typeof t !== 'function') return localize;
				return (key, params) => {
					try {
						const value = t(key, params);
						return typeof value === 'string' && value.length > 0 ? value : localize(key, params);
					} catch {
						return localize(key, params);
					}
				};
			}, [t]);
			return h(
				'button',
				{
					type: 'button',
					role: 'menuitem',
					className: 'dsh-session-delete-item',
					onClick: () => {
						closeMenu(false);
						requestDelete(sessionId, displayTitle);
					},
				},
				tr('menu.delete'),
			);
		}

		/** The confirmation dialog, owned by the app-wide overlay list. */
		function DeleteDialog(props) {
			const state = useDialogState();
			const t = props.t;
			const tr = (key, params) => {
				if (typeof t !== 'function') return localize(key, params);
				try {
					const value = t(key, params);
					return typeof value === 'string' && value.length > 0 ? value : localize(key, params);
				} catch {
					return localize(key, params);
				}
			};

			React.useEffect(() => {
				if (state === null) return void 0;
				const onKey = (event) => {
					if (event.key === 'Escape' && state.phase !== 'pending') dialog.set(null);
				};
				globalThis.addEventListener('keydown', onKey);
				return () => globalThis.removeEventListener('keydown', onKey);
			}, [state]);

			if (state === null) return null;

			const title = state.title && state.title.length > 0 ? state.title : tr('menu.delete');
			const busy = state.phase === 'pending';
			// `active` means the Host refused because the session is still live.
			const active = state.phase === 'active';

			const confirm = () => {
				dialog.set({ ...state, phase: 'pending', error: null });
				fetch(ROUTE, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId: state.sessionId }),
				})
					.then(async (response) => {
						let payload = {};
						try {
							payload = await response.json();
						} catch {
							/* a non-JSON body is reported through the status instead */
						}
						if (response.ok && payload.ok === true) {
							// The Host settles only its own stores; the browser keeps
							// per-session UI state (view, layout, draft, current-session
							// pointer) under id-bearing keys, so clear those here too.
							try {
								const id = state.sessionId;
								for (const key of Object.keys(localStorage)) {
									const value = localStorage.getItem(key);
									if (key.includes(id) || (value !== null && value.includes(id))) {
										localStorage.removeItem(key);
									}
								}
							} catch {
								/* clearing browser state must never fail a done deletion */
							}
							// Pull the Host list again so the removed row disappears now.
							try {
								refreshSessions();
							} catch {
								/* a refresh failure must not reopen a completed deletion */
							}
							dialog.set(null);
							return;
						}
						if (payload.code === 'active') {
							dialog.set({ ...state, phase: 'active', error: null });
							return;
						}
						const detail =
							payload.code === 'unknown'
								? tr('dialog.failed', { message: 'unknown session' })
								: tr('dialog.failed', { message: String(payload.message ?? payload.code ?? response.status) });
						dialog.set({ ...state, phase: 'error', error: detail });
					})
					.catch((error) => {
						dialog.set({
							...state,
							phase: 'error',
							error: tr('dialog.failed', { message: String((error && error.message) || error) }),
						});
					});
			};

			return h(
				'div',
				{
					className: 'dsh-session-delete-overlay',
					role: 'presentation',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget && !busy) dialog.set(null);
					},
				},
				h(
					'div',
					{
						className: 'dsh-session-delete-panel',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': tr('dialog.title'),
					},
					h('h2', null, active ? tr('dialog.active.title') : tr('dialog.title')),
					active ? h('p', null, tr('dialog.active.body')) : h('p', null, tr('dialog.body', { title })),
					!active ? h('p', { className: 'dsh-session-delete-path' }, tr('dialog.where')) : null,
					state.error ? h('p', { className: 'dsh-session-delete-error' }, state.error) : null,
					busy ? h('p', null, tr('dialog.pending')) : null,
					h(
						'div',
						{ className: 'dsh-session-delete-actions' },
						active
							? h('button', { type: 'button', onClick: () => dialog.set(null) }, tr('dialog.close'))
							: [
									h(
										'button',
										{ type: 'button', disabled: busy, onClick: () => dialog.set(null) },
										tr('dialog.cancel'),
									),
									h(
										'button',
										{
											type: 'button',
											className: 'dsh-session-delete-danger',
											disabled: busy,
											onClick: confirm,
										},
										tr('dialog.confirm'),
									),
								],
					),
				),
			);
		}

		return {
			inject: ['slots', 'locale', 'sessions'],
			apply(ctx) {
				refreshSessions = () => {
					try {
						ctx.sessions?.refresh?.();
					} catch {
						/* the Host list refresh is best-effort */
					}
				};

				ctx.effect(() => {
					if (typeof document === 'undefined') return () => {};
					if (document.getElementById(STYLE_ID) !== null) return () => {};
					const style = document.createElement('style');
					style.id = STYLE_ID;
					style.textContent = CSS;
					document.head.appendChild(style);
					return () => {
						if (style.parentNode !== null) style.parentNode.removeChild(style);
					};
				}, 'dsh-session-delete: styles');

				ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-session-delete: dictionaries');

				ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
					ctx.slots.register(
						{
							name: 'sidebar.workspaces.session.menu.item',
							id: 'dsh.session-delete',
							// After the shipped Archive (400), so the destructive action is last.
							order: 500,
							locale: NS,
							inject: () => ({
								requestDelete: (sessionId, displayTitle) =>
									dialog.set({
										sessionId,
										title: displayTitle,
										phase: 'confirm',
										activity: [],
										error: null,
									}),
							}),
						},
						DeleteMenuItem,
					),
				);

				ctx.slots.inject('shell.overlay', () =>
					ctx.slots.register(
						{
							name: 'shell.overlay',
							id: 'dsh.session-delete.dialog',
							locale: NS,
						},
						DeleteDialog,
					),
				);
			},
		};
	},
});
