# dsh-session-delete

给 DSH 补上官方刻意留空的「删除会话」。会话行「⋯」菜单里多一项**删除会话**，确认后：

1. 只允许**已关闭（cold）**的会话；仍在运行的会话直接拒绝，提示先关闭；
2. 把整个会话目录（完整 artifact，含 `session.vN.jsonl.zstd`）从持久化根目录**移动**到 `<DSH home>/session-trash/<时间戳>__<会话 id>/session`；
3. 不改 `workspace.json`、不移动投影缓存、不动附件；
4. 移动成功后刷新会话列表，条目立即从侧栏消失。

## 为什么移动就够

UI 列表来自 `sessionPersistence.list()` 对 `sessions/` 根目录的两级扫描
（`root/<项目>/<会话>/session.vN.jsonl.zstd`）。会话目录一旦移出该根目录，
`list()` 就不再返回它，`sessionQuery.listSessions()`（磁盘 ∪ 内存）随之丢弃该行。

- `workspace.json` 里的 `sessionIds` **不需要**同步删除：不存在 artifact 时，
  `WorkspaceEntity.sessionIds` 会按 header 派生路径索引把它过滤掉，客户端的
  工作区分组也会跳过找不到 summary 的 id。
- 投影缓存是派生数据，附件是内容寻址存储，都与「会话是否出现在列表」无关。

## 为什么只处理 cold 会话

live 会话由 `ctx.sessions` 独立持有，`listSessions()` 会无条件并入内存中的
live 会话，因此移动文件不会让它消失；更糟的是，打开的写句柄会在下一次 append
时按派生路径重建一个没有 header 的残破日志。所以插件对 live 会话直接返回：

```
Cannot remove active session. Close the session first.
```

## 回收目录

固定为 `<DSH home>/session-trash`（`sessions/` 的同级目录），不可配置——避免误落到
`sessions/` 根内触发 `legacyLayout` / `encodingMismatch` / `assertStoredIdentity` 冲突。

条目结构：

```
<DSH home>/session-trash/<时间戳>__<会话 id>/
  trash-meta.json          # 会话 id、删除时间、原路径 from
  session/                 # 原会话目录的全部内容（含 session.vN.jsonl.zstd）
```

移动用 `fs.rename`（跨盘 `EXDEV` 时回退 `cp` 后 `rm`）——纯文件系统层移动，
**不经过 Windows 回收站**，也不会被抹除。在「我的电脑 → 回收站」里找不到这些文件是预期行为。

## 恢复

本插件**不提供 Restore UI**——回收目录只是技术上的安全隔离目录，恢复是手动的：
把 `<DSH home>/session-trash/<时间戳>__<会话 id>/session/` 放回 `trash-meta.json` 里的
`from` 路径，刷新（或重启）DSH 后会话会重新出现。也可用命令行工具：

```
node bin/session-trash.mjs list                    # 列出条目：会话 id、删除时间、占用、原位置
node bin/session-trash.mjs restore <序号|会话 id>   # 还原到原位置
node bin/session-trash.mjs purge <序号|会话 id> --yes
node bin/session-trash.mjs purge --all --yes       # 彻底抹除（未加 --yes 会被拒绝）
```

> 注意：本插件不再把投影缓存移入回收目录，因此 `session-trash.mjs list` 无法从
> 缓存读出标题，会显示「(无缓存标题)」。这不影响还原与清理。

## 安装

`desktop` profile 由 Electron 应用独占，命令行 `dsh plugin` 会拒绝写入，请在界面里安装：

1. 侧栏 → **插件** → **添加插件**
2. 填入本插件目录的绝对路径（例如你克隆后的 `...\dsh-session-delete`）
3. 安装源那一栏不用动（本地绝对路径下不参与解析，本插件零依赖）
4. 安装后确认组合包已启用；客户端半边随 HMR 生效，必要时刷新页面

## 测试

两个测试都是自包含的（在临时目录里跑，不碰真实数据）：

```
node test/dsh-session-delete.test.mjs          # Host 半边 — 8/8 通过
node test/dsh-session-delete.client.test.mjs   # Client 半边 — 12/12 通过
```

Host 覆盖：非 POST / 跨源 / 路径穿越 / 未知 404 / live 拒绝且不动文件 / 移动前二次
live 检查 / cold 完整移动且 cache 原位 / 不覆盖已有条目。Client 覆盖：菜单与弹窗
注册、locale、只发 sessionId、成功后 refresh 一次、live 只显示关闭、失败保留、清理
localStorage。

## 已知限制

- **只处理 cold 会话**：运行中的会话必须先关闭。
- **只删选中的那一个会话**：子智能体会话不会被一起删除。
- **回收目录不会自动清理**：需要手动删条目或用 `purge`。
- **不做搜索索引清理**：本部署未挂载 `dsh-session-query-sqlite`。
- **只服务回环来源**：路由要求 `POST`，并校验 `Origin`、委托 `connection.requestRejection`。
- **不改 Harness 核心源码**：仅通过 bundle patch 插入插件行。
