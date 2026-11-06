/**
 * 命令鉴权 — 挂到 SlashCommand.authorized 的白名单校验
 *
 * 名单语义与审批按钮校验（approval-channel）一致：c2cMode=allowlist 时发送者
 * 必须在 c2cAllow；身份缺失同样拒绝（fail-closed）。open 模式放行。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.ts';
/** 鉴权配置投影（结构化，便于单测） */
export interface CommandAuthConfigLike {
    access: {
        c2cMode: 'open' | 'allowlist' | 'disabled';
        c2cAllow: readonly string[];
    };
}
/** 构造命令白名单鉴权回调 */
export declare function commandAllowlistAuth(config: CommandAuthConfigLike, logger?: Logger): (ctx: SlashCommandHandlerContext) => boolean | string;
//# sourceMappingURL=auth.d.ts.map