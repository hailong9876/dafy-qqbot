/** 铸造新会话 id（随机全局唯一，避免多进程并发撞出重复 id） */
export declare function mintSessionId(): string;
/** 0.5.x 老派生算法（裸 UUID）。仅用于迁移：定位存量会话，resume 命中则沿用 */
export declare function legacyDerivedSessionId(sessionKey: string): string;
//# sourceMappingURL=session-id.d.ts.map