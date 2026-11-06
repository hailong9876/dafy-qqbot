/**
 * 杂项命令
 *
 * - /bot-ping /bot-version /bot-me：QQBot 插件特有（连通性测试、版本、身份）
 * - /stop：中止当前生成（对应底层 agent cancel，通用能力）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
/** /bot-ping — 测试当前 dsh 与 QQ 连接的网络延迟 */
export declare function pingCommand(): CategorizedCommand;
/** /bot-version — 查看版本信息 */
export declare function versionCommand({ manager }: CommandDeps): CategorizedCommand;
/**
 * /bot-me — 查看发送者身份标识
 *
 * 私聊返回 user openid、群聊返回群成员 openid 与群 openid
 * （分别对应 access.c2cAllow / groupAllow 的名单 key）。
 */
export declare function meCommand({ config }: CommandDeps): CategorizedCommand;
/** /stop — 中止当前生成（隐藏） */
export declare function stopCommand({ manager }: CommandDeps): CategorizedCommand;
//# sourceMappingURL=misc.d.ts.map