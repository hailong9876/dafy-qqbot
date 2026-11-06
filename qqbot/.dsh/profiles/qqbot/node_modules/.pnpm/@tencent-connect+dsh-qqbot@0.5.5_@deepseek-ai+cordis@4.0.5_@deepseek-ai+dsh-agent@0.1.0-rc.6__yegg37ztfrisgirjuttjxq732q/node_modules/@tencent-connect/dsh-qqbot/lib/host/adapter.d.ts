/**
 * 宿主 API 适配层 — 收口所有版本漂移点，一次探测按需复用。
 *
 * 宿主新旧版本 API 形态不同（本插件踩过的漂移：events → snapshotEvents、
 * presets.serviceFor 实例方法 → serviceForAgent 模块函数、./fork 子路径导出）。
 * 调用方只依赖本模块的稳定签名，不再直接假设宿主形态。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 日志最小接口 */
export interface AdapterLogger {
    info(msg: string): void;
    warn(msg: string): void;
}
export interface HostAdapter {
    /** 会话事件读取：新宿主 snapshotEvents()，旧宿主 events getter */
    sessionEvents(session: {
        snapshotEvents?: () => readonly unknown[];
        events?: readonly unknown[];
    }): readonly unknown[];
    /** preset 作用域服务解析：旧宿主实例方法 / 新宿主模块函数 */
    serviceFor(agent: {
        ctx: unknown;
    }, name: string): Promise<unknown | undefined>;
    /** 全局服务读取（未注册返回 undefined，不抛） */
    globalService(name: string): unknown | undefined;
    /** 官方 fork seed 构造；旧宿主无导出时返回 undefined */
    buildForkSeed(events: readonly unknown[], boundary: number): Promise<readonly unknown[] | undefined>;
    /** 会话 header 读取（取 agentPreset 等）；会话不存在、服务缺失或读取失败返回 undefined */
    sessionHeader(sessionId: string): Promise<SessionHeaderLike | undefined>;
    /**
     * 会话是否存在于持久化层。
     *
     * `undefined` = 没有求证手段（宿主未注册 sessionPersistence，或其形态不含
     * `stat`）。调用方不得把它当成「不存在」——那正是重建已存在会话、撞出重复
     * id 的根因。后端真故障时照常抛出。
     */
    sessionExists(sessionId: string): Promise<boolean | undefined>;
    /** 探测结果摘要（启动契约检查用） */
    readonly capabilities: string[];
}
/** 会话 header 的最小结构（只读插件关心的字段；`agentPreset` 在 header 顶层） */
export interface SessionHeaderLike {
    agentPreset?: string;
}
export declare function createHostAdapter(ctx: Context, logger?: AdapterLogger): HostAdapter;
/** 测试辅助：清空模块缓存 */
export declare function _resetAdapterCache(): void;
//# sourceMappingURL=adapter.d.ts.map