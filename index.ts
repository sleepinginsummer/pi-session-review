import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runReview } from "./review.ts";

const configPath = fileURLToPath(new URL("./config.json", import.meta.url));

export function parseReviewArgs(args: string): { path?: string; instructions: string } {
  const input = args.trim();
  // 只有明确的 JSONL 参数才作为路径；其余文字作为本次审查的补充要求。
  const quoted = /^(["'])(.+?\.jsonl)\1(?:\s+([\s\S]*))?$/i.exec(input);
  if (quoted) return { path: quoted[2], instructions: quoted[3]?.trim() || "" };
  const pathWithInstructions = /^(\S+\.jsonl)(?:\s+([\s\S]*))?$/i.exec(input);
  if (pathWithInstructions) return { path: pathWithInstructions[1], instructions: pathWithInstructions[2]?.trim() || "" };
  // 含空格的未引号路径必须有明确前缀，避免把提到 JSONL 的整句要求当作路径。
  if (/^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])/.test(input) && /\.jsonl$/i.test(input)) {
    return { path: input, instructions: "" };
  }
  return { instructions: input };
}

/** 仅在明确返回 true 时唤醒主代理；报告缺少标记的失败不会进入此投递入口。 */
export function sendReviewReport(pi: Pick<ExtensionAPI, "sendMessage">, result: Awaited<ReturnType<typeof runReview>>) {
  const { report, ...details } = result;
  const content = result.continueDialogue
    ? `${report}\n\n请核对以上审查发现，继续处理确认需要修复的问题，并给出处理结果。`
    : report;
  pi.sendMessage({
    customType: "session-review-report", content, display: true, details,
  }, result.continueDialogue ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false });
}

/** 命令和工具共用执行入口；取消、切换和重新加载都不能把报告送到别的会话。 */
export default function (pi: ExtensionAPI) {
  let active: AbortController | undefined;
  const cancel = () => active?.abort(new Error("Review 已取消"));
  pi.on("session_shutdown", cancel);
  pi.on("session_start", cancel);

  async function execute(ctx: ExtensionContext, path?: string, signal?: AbortSignal, instructions = "") {
    if (active) throw new Error("已有 Review 正在运行，请等待完成或使用 /review cancel");
    const controller = new AbortController();
    active = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const result = await runReview(ctx, configPath, path, combined, undefined, instructions);
      combined.throwIfAborted();
      if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("会话已切换，Review 报告未投递");
      return result;
    } catch (error) {
      console.error("[pi-session-review] failed", { sessionId, path, error });
      throw error;
    } finally {
      if (active === controller) active = undefined;
    }
  }

  pi.registerCommand("review", {
    description: "执行一次独立 Review：/review [JSONL 路径] [补充要求]；cancel 取消",
    async handler(args, ctx) {
      const input = args.trim();
      if (input === "cancel") {
        cancel();
        ctx.ui.notify(active ? "正在取消 Review" : "没有正在运行的 Review", "info");
        return;
      }
      const { path, instructions } = parseReviewArgs(input);
      try {
        const result = await execute(ctx, path, undefined, instructions);
        sendReviewReport(pi, result);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "review_session", label: "审查 Pi 会话",
    description: "按 pi-session-review/config.json 的模型、思考强度和系统提示词执行一次独立审查，返回完整报告。省略 session_path 则审查当前会话。只在用户要求审查时调用。",
    parameters: Type.Object({ session_path: Type.Optional(Type.String({ description: "待审查的 Pi JSONL 文件绝对路径" })) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await execute(ctx, params.session_path, signal);
      const usage = result.usage.reduce((sum, item) => ({
        input: sum.input + item.input, output: sum.output + item.output,
        cacheRead: sum.cacheRead + item.cacheRead, cacheWrite: sum.cacheWrite + item.cacheWrite,
        totalTokens: sum.totalTokens + item.totalTokens,
        cost: {
          input: sum.cost.input + item.cost.input, output: sum.cost.output + item.cost.output,
          cacheRead: sum.cost.cacheRead + item.cost.cacheRead, cacheWrite: sum.cost.cacheWrite + item.cost.cacheWrite,
          total: sum.cost.total + item.cost.total,
        },
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
      return { content: [{ type: "text", text: result.report }], details: result, usage };
    },
  });
}
