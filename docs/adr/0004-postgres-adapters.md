# ADR 0004 — PostgreSQL 适配器：注入客户端，每个操作一条语句

状态：已采用。日期：2026-09-19。

## 背景

v0.2 的 journal 与 run store 契约已经固定（claim 原子预留、CAS 替换、终态释放、一意图一未终态 Run、事件去重）。需要一个持久实现，同时保持核心零运行时依赖，并且在没有数据库服务器的开发机和 CI 上也能验证 SQL 真的正确。

## 决策

1. **不引入驱动。** `SqlClient` 只要求 `query(text, values) → { rows }`。node-postgres 的 Pool/Client 与 PGlite 原样满足；其他驱动写十行包装即可。凭据、连接池、TLS 都归宿主。
2. **每个存储操作是一条 SQL 语句。** claim 用写入型 CTE 同时插入记录与锁行，锁冲突让整条语句回滚；replace 用 CTE 在 CAS 更新的同一语句里删除终态记录的锁。原子性由 PostgreSQL 保证，不需要跨语句事务，接口也就不需要 `transaction()`。
3. **整体存 jsonb，外加索引列。** 记录与 Run 以 `data jsonb` 保存，id、tenant、revision、status、fingerprint、wake_at 作为列。模式演进只影响列，不影响载荷。
4. **约束替代应用逻辑。** 资源锁表主键 `(tenant, resource)`；一意图一未终态 Run 用部分唯一索引；事件去重用 `(run_id, key)` 主键。唯一冲突（SQLSTATE 23505）映射为契约里的 conflict / `run-exists`。
5. **用 PGlite 离线验证。** 同一套一致性测试对内存实现和 PGlite 上的适配器各跑一遍，验收链路也在 PGlite 上重跑。设置 `COGNITIVE_HUB_PG_URL` 并安装 `pg` 时，同一套测试额外对真实服务器运行。
6. **表名带前缀 `cognitive_hub_`。** 进一步隔离靠连接上的 `search_path`，不做可配置表名。

## 代价

- CTE 语句比普通事务难读；替换失败后要再读一次才能区分版本冲突、终态和身份变化。
- jsonb 整体存储不利于按字段查询和部分更新；需要时再加列或视图。
- PGlite 与生产服务器版本可能不同；CI 没有接入真实服务器，SIGKILL 链路仍在文件存储上验证。
- 没有 outbox、没有 retention；journal 只增不删。
