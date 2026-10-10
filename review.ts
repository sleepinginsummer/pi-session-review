import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession, createExtensionRuntime, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type ExtensionContext, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface ReviewConfig {
  run_with_model: string;
  thinking_level: ThinkingLevel;
  system_prompt: string;
}

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 配置错误立即报出，不悄悄切换到其它模型或降低思考强度。 */
export function parseConfig(value: unknown): ReviewConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (typeof raw.run_with_model !== "string") throw new Error("run_with_model 必须是字符串");
  const model = raw.run_with_model.trim();
  if (model && (!model.includes("/") || model.startsWith("/") || model.endsWith("/"))) {
    throw new Error("run_with_model 必须是 provider/modelId，或留空沿用当前模型");
  }
  if (typeof raw.thinking_level !== "string" || !levels.includes(raw.thinking_level)) {
    throw new Error(`thinking_level 必须是 ${levels.join(" | ")}`);
  }
  if (typeof raw.system_prompt !== "string" || !raw.system_prompt.trim()) throw new Error("system_prompt 不能为空");
  return { run_with_model: model, thinking_level: raw.thinking_level as ThinkingLevel, system_prompt: raw.system_prompt };
}

/** 只接受报告末行的显式标记，正文里的 true/false 不参与继续决策。 */
export function parseReviewResponse(text: string): { report: string; continueDialogue: boolean } {
  const report = text.trim();
  const lines = report.split(/\r?\n/);
  const marker = /^continue_dialogue:\s*(true|false)$/.exec(lines.at(-1) || "");
  if (!marker) throw new Error("Review 报告缺少有效的末行标记：continue_dialogue: true 或 false");
  if (!lines.slice(0, -1).join("\n").trim()) throw new Error("Review 模型只返回了标记，没有返回报告");
  return { report, continueDialogue: marker[1] === "true" };
}

export function resolveSessionPath(input: string | undefined, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
  const path = input?.trim() || ctx.sessionManager.getSessionFile();
  if (!path) throw new Error("当前会话没有文件，请显式提供 JSONL 路径");
  const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  if (!expanded.toLowerCase().endsWith(".jsonl")) throw new Error("会话文件必须是 .jsonl");
  return resolve(ctx.cwd, expanded);
}

/** 按字符分页，不丢弃工具结果中的长行；所有页来自同一次文件快照。 */
export function snapshotPage(snapshot: string, offset = 0, limit = 12000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.length) throw new Error("offset 超出会话快照范围");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw new Error("limit 必须在 1 到 20000 之间");
  let end = Math.min(snapshot.length, offset + limit);
  // 避免把 UTF-16 代理对切开，next_offset 必须用于读取下一页。
  if (end < snapshot.length && /[\uD800-\uDBFF]/.test(snapshot[end - 1])) end++;
  return { text: snapshot.slice(offset, end), next_offset: end, total_characters: snapshot.length, eof: end === snapshot.length };
}

export async function runReview(
  ctx: ExtensionContext,
  configPath: string,
  sessionPath: string | undefined,
  signal: AbortSignal,
  agentDir = getAgentDir(),
  instructions = "",
) {
  signal.throwIfAborted();
  const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
  const filePath = resolveSessionPath(sessionPath, ctx);
  const currentFile = ctx.sessionManager.getSessionFile();
  const leafId = currentFile && resolveSessionPath(currentFile, ctx) === filePath
    ? ctx.sessionManager.getLeafId() : undefined;
  const snapshot = await readFile(filePath, "utf8");
  const header = JSON.parse(snapshot.split(/\r?\n/, 1)[0]);
  if (header?.type !== "session" || typeof header.cwd !== "string" || typeof header.id !== "string") {
    throw new Error("文件缺少有效的 Pi session header");
  }
  const cwd = header.cwd;
  const fullId = config.run_with_model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
  if (!fullId) throw new Error("请在配置中指定 run_with_model，当前会话没有可沿用的模型");
  const slash = fullId.indexOf("/");
  const provider = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const runtime = await ModelRuntime.create({ authPath: resolve(agentDir, "auth.json"), modelsPath: resolve(agentDir, "models.json") });
  // 保留主会话扩展注册的 provider，但不加载扩展工厂，防止递归启动 Shadow 等插件。
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(provider);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(provider);
  if (nativeProvider) runtime.registerNativeProvider(nativeProvider);
  if (providerConfig) runtime.registerProvider(provider, providerConfig);
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`找不到 Review 模型：${fullId}`);
  if (model.thinkingLevelMap?.[config.thinking_level] === null) throw new Error(`模型不支持 ${config.thinking_level} 思考强度`);
  signal.throwIfAborted();

  // 完全独立的资源边界：只采用配置提示词，不继承主代理的扩展、技能或上下文指令。
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => config.system_prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: config.thinking_level,
    resourceLoader, sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    tools: ["read", "grep", "find", "ls", "read_review_session"],
    customTools: [{
      name: "read_review_session", label: "读取待审查会话",
      description: "分页读取指定 JSONL 会话的固定快照。offset 从 0 开始，使用 next_offset 继续，直到 eof。分页可能在 JSON 行中间切开。",
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
      }),
      async execute(_id, params) {
        const { offset, limit } = params as { offset?: number; limit?: number };
        const page = snapshotPage(snapshot, offset, limit);
        return { content: [{ type: "text", text: JSON.stringify(page) }], details: page };
      },
    }],
  });
  const abort = () => { void session.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    if (session.thinkingLevel !== config.thinking_level) {
      throw new Error(`模型将思考强度从 ${config.thinking_level} 调整为 ${session.thinkingLevel}，请修改配置`);
    }
    console.info("[pi-session-review] start", { filePath, model: fullId, thinkingLevel: session.thinkingLevel });
    // 补充要求作为用户消息传递，配置中的系统提示词保持不变。
    const additionalPrompt = instructions.trim() ? `

本次审查的补充要求：
${instructions.trim()}` : "";
    await session.prompt(`请审查此 Pi 会话：${JSON.stringify(filePath)}
会话 ID：${header.id}
${leafId ? `当前活动分支 leaf ID：${leafId}，优先审查该分支。
` : ""}快照长度：${snapshot.length} 字符。
先用 read_review_session 获取会话内容，再根据系统提示词完成审查。${additionalPrompt}`);
    signal.throwIfAborted();
    const last = session.messages.filter((message) => message.role === "assistant").at(-1);
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted" || last.stopReason === "length")) {
      throw new Error(last.errorMessage || `Review 未正常完成：${last.stopReason}`);
    }
    const text = session.getLastAssistantText()?.trim();
    if (!text) throw new Error("Review 模型没有返回报告");
    const { report, continueDialogue } = parseReviewResponse(text);
    const usage = session.messages.flatMap((message) => message.role === "assistant" ? [message.usage] : []);
    console.info("[pi-session-review] complete", { filePath, requests: usage.length, continueDialogue });
    return { report, continueDialogue, filePath, model: fullId, thinkingLevel: session.thinkingLevel, usage };
  } finally {
    signal.removeEventListener("abort", abort);
    session.dispose();
  }
}
