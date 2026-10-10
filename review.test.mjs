import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";

// 使用宿主现有依赖，插件自身不安装或打包 Pi SDK。
const host = resolve(process.env.PI_REVIEW_HOST_ROOT || process.cwd());
const require = createRequire(resolve(host, "package.json"));
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": resolve(host, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    typebox: require.resolve("typebox"),
  },
});
const { parseConfig, parseReviewResponse, snapshotPage, runReview } = await jiti.import("./review.ts");
const { default: extension, parseReviewArgs, sendReviewReport } = await jiti.import("./index.ts");

test("命令区分补充要求与 JSONL 路径，保留多行和带空格路径", () => {
  assert.deepEqual(parseReviewArgs(""), { instructions: "" });
  assert.deepEqual(parseReviewArgs("  重点检查并发  "), { instructions: "重点检查并发" });
  assert.deepEqual(parseReviewArgs("检查并发\n再检查异常"), { instructions: "检查并发\n再检查异常" });
  assert.deepEqual(parseReviewArgs("/tmp/source.jsonl"), { path: "/tmp/source.jsonl", instructions: "" });
  assert.deepEqual(parseReviewArgs("source.jsonl 检查异常"), { path: "source.jsonl", instructions: "检查异常" });
  assert.deepEqual(parseReviewArgs('"/tmp/my session.jsonl" 检查并发'), { path: "/tmp/my session.jsonl", instructions: "检查并发" });
  assert.deepEqual(parseReviewArgs("/tmp/my session.jsonl"), { path: "/tmp/my session.jsonl", instructions: "" });
  assert.deepEqual(parseReviewArgs("重点检查会话 source.jsonl"), { instructions: "重点检查会话 source.jsonl" });
  assert.deepEqual(parseReviewArgs("请比较 first.jsonl 和 second.jsonl"), { instructions: "请比较 first.jsonl 和 second.jsonl" });
  assert.deepEqual(parseReviewArgs("./my session.jsonl"), { path: "./my session.jsonl", instructions: "" });
});

test("报告仅按末行布尔标记解析，缺失或非法标记直接报错", () => {
  assert.equal(parseReviewResponse("发现缺陷\ncontinue_dialogue: true").continueDialogue, true);
  assert.equal(parseReviewResponse("正文提到了 true\r\ncontinue_dialogue: false\r\n").continueDialogue, false);
  for (const report of ["没有问题", "报告\ncontinue_dialogue: yes", "报告\ncontinue_dialogue: TRUE", "报告\ncontinue_dialogue: true\n后续文字", "continue_dialogue: false"]) {
    assert.throws(() => parseReviewResponse(report));
  }
});

test("配置拒绝错误模型格式、强度和空提示词", () => {
  const base = { run_with_model: "test/model/with-slash", thinking_level: "high", system_prompt: "审查" };
  assert.equal(parseConfig(base).run_with_model, base.run_with_model);
  assert.throws(() => parseConfig({ ...base, run_with_model: "invalid" }));
  assert.throws(() => parseConfig({ ...base, thinking_level: "extreme" }));
  assert.throws(() => parseConfig({ ...base, system_prompt: " " }));
});

test("长行、中文和 emoji 分页重组不丢失", () => {
  const source = "会话😀".repeat(9000);
  let offset = 0;
  let result = "";
  do {
    const page = snapshotPage(source, offset, 13);
    result += page.text;
    offset = page.next_offset;
  } while (offset < source.length);
  assert.equal(result, source);
  assert.throws(() => snapshotPage(source, -1));
});

function registration() {
  const commands = new Map();
  const events = new Map();
  const tools = new Map();
  const messages = [];
  extension({
    on: (name, fn) => events.set(name, fn),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    sendMessage: (message, options) => messages.push({ message, options }),
  });
  return { commands, events, tools, messages };
}

test("注册命令与工具，空闲取消不调用模型", async () => {
  const registered = registration();
  assert.ok(registered.tools.has("review_session"));
  assert.ok(registered.events.has("session_shutdown"));
  const notifications = [];
  await registered.commands.get("review").handler("cancel", {
    ui: { notify: (...args) => notifications.push(args) },
  });
  assert.equal(notifications[0][0], "没有正在运行的 Review");
  assert.equal(registered.messages.length, 0);
});

test("真实 SDK 经本地模型接口读取快照并返回报告，不改动来源文件", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-session-review-test-"));
  const requests = [];
  let behavior = "normal";
  let decision = "true";
  let requestArrived;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    if (behavior === "error") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "测试模型拒绝请求", type: "invalid_request_error" } }));
      return;
    }
    if (behavior === "hang") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": waiting\n\n");
      requestArrived();
      return;
    }
    const tool = requests.length === 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: "test", object: "chat.completion.chunk", created: 1, model: "review-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    chunk({ role: "assistant" });
    if (tool) chunk({ tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read_review_session", arguments: '{"offset":0}' } }] });
    else chunk({ content: behavior === "invalid" ? "报告没有标记" : `审查完成：测试报告。\ncontinue_dialogue: ${decision}` });
    chunk({}, tool ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  await writeFile(resolve(directory, "models.json"), JSON.stringify({ providers: {
    "review-test": { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-test", models: [{
      id: "review-model", reasoning: true, contextWindow: 32000, maxTokens: 2000,
      thinkingLevelMap: { high: "high" },
    }] },
  } }));
  const config = resolve(directory, "config.json");
  await writeFile(config, JSON.stringify({ run_with_model: "review-test/review-model", thinking_level: "high", system_prompt: "仅检查证据。" }));
  const file = resolve(directory, "source.jsonl");
  const source = `${JSON.stringify({ type: "session", version: 3, id: "source-session", cwd: directory })}\n${JSON.stringify({ type: "message", id: "user-1", parentId: null, message: { role: "user", content: "请检查需求是否遗漏" } })}\n`;
  await writeFile(file, source);
  const ctx = {
    cwd: directory, sessionManager: { getSessionFile: () => file, getLeafId: () => "user-1" },
    modelRegistry: { getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => undefined },
  };
  const instructions = parseReviewArgs("重点检查并发\n核对异常处理").instructions;
  const result = await runReview(ctx, config, undefined, new AbortController().signal, directory, instructions);
  assert.equal(result.report, "审查完成：测试报告。\ncontinue_dialogue: true");
  assert.equal(result.continueDialogue, true);
  const delivered = [];
  const pi = { sendMessage: (message, options) => delivered.push({ message, options }) };
  sendReviewReport(pi, result);
  assert.deepEqual(delivered[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(delivered[0].message.details.continueDialogue, true);
  assert.ok(delivered[0].message.content.includes("继续处理确认需要修复的问题"));
  assert.equal(result.thinkingLevel, "high");
  assert.equal(requests.length, 2);
  assert.ok(requests[0].messages.some((message) => ["system", "developer"].includes(message.role) && JSON.stringify(message.content).includes("仅检查证据。")));
  assert.ok(requests[0].messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(file)));
  assert.ok(requests[0].messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("当前活动分支 leaf ID：user-1")));
  assert.ok(requests[0].messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("重点检查并发") && JSON.stringify(message.content).includes("核对异常处理")));
  assert.equal(await readFile(config, "utf8"), JSON.stringify({ run_with_model: "review-test/review-model", thinking_level: "high", system_prompt: "仅检查证据。" }));
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("请检查需求是否遗漏")));
  assert.equal(requests[0].reasoning_effort, "high");
  assert.deepEqual(requests[0].tools.map((tool) => tool.function.name).sort(), ["find", "grep", "ls", "read", "read_review_session"]);
  assert.equal(await readFile(file, "utf8"), source);
  assert.equal(result.usage.length, 2);
  await assert.rejects(runReview(ctx, config, undefined, AbortSignal.abort(new Error("已取消")), directory), /已取消/);
  await writeFile(config, JSON.stringify({ run_with_model: "review-test/missing", thinking_level: "high", system_prompt: "审查" }));
  await assert.rejects(runReview(ctx, config, undefined, new AbortController().signal, directory), /找不到 Review 模型/);
  assert.equal(requests.length, 2);
  await writeFile(config, JSON.stringify({ run_with_model: "review-test/review-model", thinking_level: "high", system_prompt: "新的审查提示词" }));
  behavior = "error";
  await assert.rejects(runReview(ctx, config, file, new AbortController().signal, directory), /测试模型拒绝请求/);
  assert.ok(requests.at(-1).messages.some((message) => JSON.stringify(message.content).includes("新的审查提示词")));
  behavior = "hang";
  const arrived = new Promise((done) => { requestArrived = done; });
  const controller = new AbortController();
  const pending = runReview(ctx, config, file, controller.signal, directory);
  const cancelled = assert.rejects(pending, /运行中取消/);
  await arrived;
  controller.abort(new Error("运行中取消"));
  await cancelled;
  behavior = "normal";
  decision = "false";
  const noContinuation = await runReview(ctx, config, file, new AbortController().signal, directory);
  assert.equal(noContinuation.continueDialogue, false);
  sendReviewReport(pi, noContinuation);
  assert.deepEqual(delivered[1].options, { triggerTurn: false });
  assert.equal(delivered[1].message.content, noContinuation.report);
  assert.equal(delivered[1].message.details.continueDialogue, false);
  behavior = "invalid";
  await assert.rejects(runReview(ctx, config, file, new AbortController().signal, directory), /缺少有效的末行标记/);
  assert.equal(delivered.length, 2);
});
