import type { ModelRoute } from './types.ts';
/** 日志回调（可选） */
type DebugFn = (msg: string) => void;
/** 持久化异常回调（可选，应接 warn 级日志——映射丢失影响会话连续性，需可见） */
type ErrorFn = (msg: string) => void;
export declare class PrefsStore {
    /** per-peer 模型偏好（内存态） */
    private overrides;
    /** per-peer 最新 sessionId（fork 后更新，内存态） */
    private sessionIds;
    /** per-peer preset 偏好（内存态） */
    private presets;
    /** 本进程显式删除的 key（防止并发合并把删除复活） */
    private deleted;
    /** 隔离偏好文件路径 */
    private readonly prefsPath;
    private readonly debugLog?;
    private readonly onError?;
    constructor(debugLog?: DebugFn, options?: {
        path?: string;
        onError?: ErrorFn;
    });
    getOverride(sessionKey: string): ModelRoute | undefined;
    setOverride(sessionKey: string, route: ModelRoute): void;
    clearOverride(sessionKey: string): boolean;
    hasOverride(sessionKey: string): boolean;
    getSessionId(sessionKey: string): string | undefined;
    setSessionId(sessionKey: string, sessionId: string): void;
    clearSessionId(sessionKey: string): boolean;
    getPreset(sessionKey: string): string | undefined;
    setPreset(sessionKey: string, presetId: string): void;
    clearPreset(sessionKey: string): boolean;
    private load;
    /**
     * 读取磁盘当前状态用于合并。
     *
     * 不存在 → null（首次写）；损坏（半截 JSON 等）→ 先备份原文件再返回 null：
     * 损坏文件通常只是尾部截断，前面的映射条目往往完好，直接覆盖会把它们一并
     * 丢掉（用户表现为「QQ 里丢上下文」且无从恢复）。备份保留一份人工可救的证据。
     */
    private readDiskState;
    /** 损坏文件只备份一次（避免每次写入都产生新备份），失败不阻断写入 */
    private corruptedBackedUp;
    private backupCorrupted;
    /** 合并内存与磁盘（内存覆盖同 key，磁盘独有的其他写者条目保留，墓碑 key 除外） */
    private mergeDisk;
    private write;
}
export {};
//# sourceMappingURL=prefs-store.d.ts.map