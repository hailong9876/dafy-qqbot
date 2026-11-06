import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ModelRoute, ModelEntry } from '../model/types.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import type { DshAgent, DshAgentRegistry, PresetEntry, PresetSwitchOutcome, SessionRecord, SessionStatus, TokenUsageStats, CompactOutcome } from './types.ts';
/** 复刻宿主 latestCompletedPrefixBoundary：最后一个 turn/end 起到下一 turn 开始前的边界 */
export declare function latestCompletedPrefixBoundary(events: readonly unknown[]): number | undefined;
export declare class SessionManager {
    private sessions;
    /**
     * 同 key 正在进行的 getOrCreate（singleflight）。
     *
     * 斜杠命令与待答问题截获位于 concurrencyGuard 之前（见 gateway/middleware-setup），
     * 与普通消息不串行：同 key 并发进入会各自 resume/create，产出两个 agent，
     * 后写入 sessions 的覆盖前者且前者无人 dispose（泄漏）。
     */
    private inflight;
    private readonly evictor;
    private readonly modelResolver;
    private readonly ctx;
    private readonly host;
    private readonly agents;
    private readonly config;
    private readonly logger;
    /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
    questionChannel?: QuestionChannel;
    /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
    approvalChannel?: ApprovalChannel;
    constructor(ctx: Context, agents: DshAgentRegistry, config: ImQQBotConfig, logger: Logger);
    /**
     * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
     *
     * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
     * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
     * 额外 prompt 时原样返回，不做改动。
     */
    private registerScopePromptInjection;
    /**
     * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
     */
    private getPresetsService;
    /**
     * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
     * 读不到（服务缺失 / session 不存在 / 未记录 agentPreset）返回 undefined。
     */
    private resolvePersistedPreset;
    getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined;
    /**
     * 获取指定 peer 的生效 preset（per-peer 覆盖 > config.preset）
     */
    getEffectivePreset(scope: ChatScope, peerId: string): string | undefined;
    /** 按 sessionKey 解析生效 preset */
    private getEffectivePresetByKey;
    /**
     * 列出所有可用 preset（/preset 命令用）
     */
    listPresets(): Promise<PresetEntry[]>;
    /**
     * 切换模型（fork + 重建会话，保留历史）
     */
    setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<void>;
    /**
     * 切换指定 peer 的 agent preset（per-peer 覆盖）
     *
     * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
     * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
     */
    setPresetOverride(scope: ChatScope, peerId: string, presetId: string): Promise<PresetSwitchOutcome>;
    /**
     * 清除 per-peer preset 覆盖，回到 config.preset / 默认（新会话生效）
     */
    clearPresetOverride(scope: ChatScope, peerId: string): Promise<PresetSwitchOutcome>;
    /**
     * fork + 重建会话（保留历史，换 model）
     *
     * options.route 缺省时沿用当前生效值。preset 沿用当前生效 preset（getEffectivePresetByKey）。
     * fork 不可用或失败时降级为 dispose（下次消息重建）。
     */
    private rebuildSession;
    clearModelOverride(scope: ChatScope, peerId: string): void;
    listAvailableModels(): Promise<ModelEntry[]>;
    listProviders(): string[];
    getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined;
    getStatus(scope: ChatScope, peerId: string): SessionStatus;
    getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats;
    exportMarkdown(scope: ChatScope, peerId: string): string;
    private countMessages;
    private sessionKey;
    /** prefs 命中沿用；miss 返回 0.5.x 派生候选，由 getOrCreate 按 resume 结果迁移或铸造 */
    private currentSessionId;
    /** 候选命中后落盘，后续永远走 prefs */
    private persistSessionId;
    private composePreset;
    /** 获取或恢复或创建会话（get → resume → create）；同 key 并发合并为一次 */
    getOrCreate(scope: ChatScope, peerId: string, senderId: string, replyTarget: ReplyTarget): Promise<SessionRecord>;
    /** getOrCreate 的实际打开流程（已通过 singleflight 保证同 key 串行） */
    private openSession;
    /**
     * resume 失败后是否允许首次创建。
     *
     * 只有「会话确实不在盘上」才可创建：损坏/占用/后端故障沿用同一 id 重建，会把
     * 同一 sessionId 写进多个 project 目录，宿主 `list()` 随后报 duplicate，会话
     * 列表整体打不开（对齐宿主 `restoreOrCreateConfigured` 的 fail-loud 语义）。
     *
     * @returns 允许创建返回 true；拒绝时已记录 warn，调用方应抛出原 resume 错误。
     */
    private mayCreateAfterResumeFailure;
    /**
     * 确认候选会话缺失后决定用哪个 id 新建。
     *
     * - resume 等待期间 prefs 被并发改写（`/new` 换新会话）：采用 prefs 的最新 id，
     *   否则内存与 prefs 指向不同会话，重启后用户被切走；
     * - 候选来自 0.5.x 确定性派生：一律铸造新 id，确定性 id 不进入新建路径；
     * - 候选来自 prefs 且确认缺失：沿用该 id 新建，prefs 无需改写。
     */
    private resolveCreateId;
    findBySessionId(sessionId: string): SessionRecord | undefined;
    findByAgent(agent: DshAgent): SessionRecord | undefined;
    remove(scope: ChatScope, peerId: string): Promise<void>;
    /** Agent 工作目录：显式配置优先，缺省独立目录 ~/.dsh-qqbot/workspace（不随宿主进程 cwd） */
    private workspaceCache;
    private workspaceDir;
    /**
     * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
     *
     * compaction 是 preset 作用域服务，经 host adapter 从会话 preset 解析，
     * 全局注册的部署再兜底。这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
     */
    compact(scope: ChatScope, peerId: string, revive?: {
        senderId: string;
        replyTarget: ReplyTarget;
    }): Promise<CompactOutcome>;
    disposeAll(): Promise<void>;
    get size(): number;
}
//# sourceMappingURL=session-manager.d.ts.map