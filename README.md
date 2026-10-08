# SMS Code Graph Worker

内部代码图谱构建与查询适配服务。当前固定使用 GitNexus 1.6.12，并隔离其 CLI、Registry、LadybugDB 与索引目录结构。

## M1 能力

- 接收固定 Commit/Tree 的源码 tar 包并校验 SHA-256。
- 防止 tar 路径穿越，校验解包后的 Git Commit 与 Tree。
- 异步 FULL Build、持久化任务状态、并发限制和进程超时。
- 普通构建失败后最多一次 `--force` 恢复。
- 使用 `status + smoke query` 校验索引，不把业务环依赖作为索引失败。
- Temp → Validate → tar.zst → atomic rename 发布。
- Query/Context/Impact/Trace 标准 DTO。
- 显式 HTTP route prefix manifest，解决 axios baseURL 与后端路由前缀分离的问题。

## M4 增量与多仓复用

Build 请求可以携带 `reusePlan` 和 `baseBundleArtifactUri/baseBundleSha256`。平台为每个仓库声明 `EXACT`、`INCREMENTAL` 或 `FULL`：

- `EXACT`：恢复对应仓库的 `.gitnexus`，校验 commit/tree 一致，不执行 Analyze。
- `INCREMENTAL`：恢复 base `.gitnexus`，校验 base commit 是目标 commit 的祖先，再执行 GitNexus Analyze。
- `FULL`：从目标源码重新 Analyze。

所有仓库准备完成后才执行 Group Sync；任一仓库失败不会发布 Bundle。Worker 不自行选择 base，也不接受未经过平台指纹和权限校验的快照。

## 本地运行

```bash
docker build -t sms/code-graph-worker:0.1.0 .
docker run --rm -p 4780:8080 \
  -e CODE_GRAPH_INTERNAL_TOKEN='<internal-secret>' \
  -v sms-code-graph-data:/data/code-graph \
  sms/code-graph-worker:0.1.0
```

接口契约见 `sms-docs/执行计划/code-graph-worker-openapi-v0.1.yaml`。

## 安全边界

- Worker 不接收 Git Token，也不解析动态 Branch。
- 除健康检查外，所有接口必须携带内部 Bearer Token。
- 外部命令全部使用参数数组执行，不使用 shell。
- 平台查询不能透传 Cypher。
- M1 只接受挂载在 `CODE_GRAPH_SOURCE_FILE_ROOTS` 下的 `file://` 源码包；生产对象存储下载由后续受控 Source Delivery Adapter 提供。
