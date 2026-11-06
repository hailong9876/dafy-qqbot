import type { Context } from '@deepseek-ai/cordis';
import type { VisionConfig } from '../config.ts';
import type { Logger } from '../types.ts';
/** 工具名（qqbot 前缀避免与外部 describe-image 包的同名工具冲突） */
export declare const DESCRIBE_IMAGE_TOOL_NAME = "qqbot_describe_image";
/**
 * 启动时检查 settings.yaml 里 vision 模型的 input 模态是否声明了 image。
 *
 * 模型配置界面不暴露 `input` 字段，用户通过界面配置的视觉模型默认是纯文本，
 * 会导致 pi-ai adapter 拒绝图片输入。这里在启动时兜底：未声明 image 时自动补 `[text, image]`。
 *
 * 写入遵循与 setup/persist.ts 相同的约束（该文件是宿主用户级配置，多写者共存）：
 * - 文档保真：eemeli/yaml Document API 原地编辑，注释/锚点/其他配置原样保留；
 * - 原子写：同目录临时文件 + rename，崩溃不留半份文件；
 * - 乐观校验：写入窗口内文件被外部改动则放弃本次补写（幂等，下次启动再补）；
 * - fail-closed：解析失败仅 warn 不阻断启动（视觉功能可另行手动配置）。
 * 幂等：已声明 image 则不写（不触 mtime，不引发宿主重载）。
 */
export declare function ensureVisionInputModal(vision: VisionConfig, logger: Logger): void;
/** 注册 qqbot_describe_image 工具（服务缺失时优雅降级，不阻断插件启动） */
export declare function registerDescribeImageTool(ctx: Context, vision: VisionConfig, logger: Logger): void;
//# sourceMappingURL=vision-tool.d.ts.map