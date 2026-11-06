import type { Logger, RawAttachment } from '../types.ts';
import type { MediaConfig } from '../config.ts';
/** 下载结果 */
export interface DownloadedFile {
    /** QQ 下发的原始文件名（仅作来源标注，扩展名不可信——可能与 localPath 不一致） */
    filename: string;
    /** 附件类型 */
    contentType: 'image' | 'video' | 'file';
    /** 本地绝对路径；图片扩展名已按 magic bytes 校正（判类型以此为准，勿用 filename） */
    localPath: string;
}
/** 附件归类（QQ 网关的 content_type 是 MIME 类型，如 image/png、video/mp4、audio/silk） */
export type MediaKind = 'image' | 'video' | 'voice' | 'file';
/** 是否为图片（兼容裸值 'image' 与 MIME 'image/png'） */
export declare function isImageContentType(contentType?: string): boolean;
/** 是否为视频（兼容裸值 'video' 与 MIME 'video/mp4'） */
export declare function isVideoContentType(contentType?: string): boolean;
/** 是否为语音（兼容裸值 'voice' 与 MIME 'audio/silk'） */
export declare function isVoiceContentType(contentType?: string): boolean;
/** 归类附件 content_type 为统一类型 */
export declare function classifyContentType(contentType?: string): MediaKind;
/**
 * 按魔数（magic bytes）识别图片真实扩展名，无法识别返回 undefined。
 *
 * 纯函数、零 I/O：QQ 网关的 content_type 统一标 image/png 不可信，只有文件头
 * 可靠。每个分支都带长度守卫，短于所需字节的 buffer 直接落到末尾 undefined。
 */
export declare function imageExtension(buf: Buffer): string | undefined;
/**
 * 按图片真实格式修正路径扩展名，保留文件名主体（纯函数）。
 * 未识别 / 已一致 / jpg≈jpeg 时原样返回，避免无意义改名。
 */
export declare function correctImageExt(path: string, buf: Buffer): string;
/**
 * 下载消息中的富媒体附件（image/video/file）到本地
 *
 * 下载目录固定为 ~/.dsh-qqbot/media，文件名用时间戳+随机数防重名。
 * 下载失败不阻断（由调用方回退描述）。
 */
export declare function downloadMediaAttachments(attachments: RawAttachment[] | undefined, media: MediaConfig, logger: Logger): Promise<DownloadedFile[]>;
//# sourceMappingURL=attachment.d.ts.map