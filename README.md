# pi-session-review

手动启动一个独立 Pi 代理，审查当前会话最近一轮任务修改的代码。模型、思考强度和系统提示词由配置文件指定；发现需要修复的问题时，可自动唤醒主代理继续处理。

参考 [pi-shadow-mind](https://github.com/liu-zhengdong/pi-shadow-mind) 的独立 `AgentSession` 方式实现，不依赖该插件。适用于 Pi TUI 和 Pi Web，已使用 Pi SDK 1.0.0 验证。

## 安装

### 从 GitHub 安装

```bash
pi install git:github.com/sleepinginsummer/pi-session-review
```

安装后先创建配置。默认全局安装目录如下；如果设置了 `PI_CODING_AGENT_DIR`，命令会使用该目录：

```bash
cd "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/sleepinginsummer/pi-session-review"
cp -n config.example.json config.json
```

`config.example.json` 包含完整中文审查提示词，默认沿用当前会话模型，思考强度为 `medium`。编辑 `config.json` 可以指定自己的模型和审查规则。插件不会自动生成配置，首次使用前必须完成这一步。

在已有会话中执行 `/reload`。Pi Web 也可以使用会话的“重新加载”操作；重新打开插件列表可看到 `pi-session-review`，加载完成后命令菜单会出现 `/review`。

### 从本地源码安装

```bash
git clone https://github.com/sleepinginsummer/pi-session-review.git
cd pi-session-review
cp -n config.example.json config.json
pi install .
```

安装后同样需要重新加载已有会话。临时加载单个扩展文件可以使用：

```bash
pi -e ./index.ts
```

运行时依赖由 Pi 宿主提供，无需在插件目录执行 `npm install`。本地安装和 Git 安装应选择一种，避免把同一扩展加载两次。

## 配置

配置位于插件目录的 `config.json`，每次运行重新读取；只修改配置无需 `/reload`。个人配置已加入 `.gitignore`，仓库只提交可复制的示例文件。

### 沿用当前模型

[config.example.json](./config.example.json) 是可以直接复制的完整配置。下面是一个更简短、仍符合报告输出约定的示例：

```json
{
  "run_with_model": "",
  "thinking_level": "medium",
  "system_prompt": "你是一名务实的代码审查者。先用 read_review_session 读取会话，确认最近一轮任务的需求与修改范围，再使用只读工具核对当前代码。只报告有证据、与本次修改直接相关的问题，给出文件位置、触发条件、影响和修复建议。可选优化必须说明收益和代价。不要修改文件，不为凑数提出问题。用中文返回报告。最后一行必须单独输出 continue_dialogue: true 或 continue_dialogue: false，不使用代码块，该行之后不再输出内容。有明确需要主代理修复的缺陷时返回 true，否则返回 false。"
}
```

### 固定模型和思考强度

保留示例中的完整 `system_prompt`，修改前两个字段即可。例如使用 Pi 中已经配置的 OpenAI 模型：

```json
{
  "run_with_model": "openai/gpt-5",
  "thinking_level": "high",
  "system_prompt": "先使用 read_review_session 读取会话，再核对本次修改的实际代码。重点检查需求遗漏、边界条件、状态与并发、异常处理和回归风险。只报告有证据的问题，给出具体代码位置与最小修复建议。不得修改文件。用中文返回报告。最后一行必须单独输出 continue_dialogue: true 或 continue_dialogue: false，不使用代码块，该行之后不再输出内容。有明确需要主代理修复的缺陷时返回 true，否则返回 false。"
}
```

自定义 provider 同样使用 `provider/modelId`，例如 `my-provider/my-model-id`。填写的是模型 **ID**，不是界面显示名称；可以从 Pi 的 `models.json` 中查看 `models[].id`。示例模型也需要你的 Pi 已有相应配置和凭据。

| 字段 | 含义 |
| --- | --- |
| `run_with_model` | 完整 `provider/modelId`；空字符串表示沿用发起审查时当前会话的模型。不会改变主会话模型。 |
| `thinking_level` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。模型不支持或 SDK 降低强度时会报错。 |
| `system_prompt` | 独立 Review 代理的系统提示词，必须保留末行布尔标记的输出约定。 |

模型和凭据沿用 Pi 的 agent directory，默认是 `~/.pi/agent`，支持 `PI_CODING_AGENT_DIR`。不要在插件配置中填写 API key。

## 使用

审查当前会话最近一轮任务的代码改动：

```text
/review
```

附带本次审查的补充要求，文字会和会话信息一起发给 Review 模型：

```text
/review 重点检查并发和异常处理，看看有没有可以简化的逻辑
```

审查指定的会话文件：

```text
/review /absolute/path/session.jsonl
```

指定文件并追加补充要求：

```text
/review /absolute/path/session.jsonl 重点检查需求是否遗漏
/review "/path with spaces/session.jsonl" 重点检查状态更新
```

支持 `~/`、绝对路径和相对于发起会话 cwd 的路径。含空格的相对路径需加引号；含空格路径后追加要求也需加引号。普通整句文字不会因为最后提到了 `source.jsonl` 就被当成路径。

取消正在运行的审查：

```text
/review cancel
```

### 报告与后续对话

报告以 `session-review-report` 消息显示并保存到发起会话。最后一行是模型给出的继续标记：

```text
continue_dialogue: true
```

- `true`：发现明确需要修复的缺陷，以 `followUp` 唤醒主代理，让它核对并继续处理。
- `false`：没有明确缺陷，或只有可选优化，仅显示报告。

标记缺失、值不合法、没有报告正文或输出被截断时会报错，不自动继续。修改系统提示词时必须保留这项输出约定。

### 工具调用

插件还注册了 `review_session` 工具，供主代理在用户要求审查时调用。省略参数审查当前会话，或者传入指定路径：

```json
{
  "session_path": "/absolute/path/session.jsonl"
}
```

工具返回完整报告，`details.continueDialogue` 保存解析后的布尔值，并记录模型用量。工具调用仍遵循 Pi 的正常工具处理流程；上面的自动唤醒规则作用于 `/review` 命令。

## 更新与卸载

更新从 GitHub 安装的插件：

```bash
pi update git:github.com/sleepinginsummer/pi-session-review
```

更新后重新加载会话。本地 `config.json` 不在 Git 跟踪范围内；覆盖配置前自行保留需要的设置。

卸载 Git 安装的插件：

```bash
pi remove git:github.com/sleepinginsummer/pi-session-review
```

## 执行方式与限制

- “一次”指一次独立 Review 任务。读取工具会产生多次模型请求，没有自动触发审查或自动循环审查。
- 运行开始时读取一份 JSONL 快照，模型使用 `read_review_session` 分页读取，长 JSON 行不会丢失；运行后的追加不进入这次审查。
- 当前会话会附带活动分支 leaf ID；Review 代理的 cwd 来自目标文件 header。
- 可用工具只有 `read_review_session`、`read`、`grep`、`find`、`ls`，用于读取会话和核对代码，不提供写入工具。
- 独立代理在内存中运行，不载入主会话扩展、技能、AGENTS.md 或 APPEND_SYSTEM.md。
- 不自动重试或压缩。内容超出模型上下文、请求失败或报告被截断时会报错，不裁剪输入或替换模型。
- 同一插件运行时仅允许一个任务；会话关闭、替换或重新加载会取消任务。
- 插件不直接改写目标会话，命令报告通过主会话 SDK 保存。若目标就是主会话，该文件会正常追加报告。

## 开发与验证

源码入口是 [index.ts](./index.ts)，独立代理执行与报告解析位于 [review.ts](./review.ts)。测试使用真实 Pi SDK 和本地模拟 OpenAI 接口，不调用付费模型。

指定一个已安装 Pi SDK、typebox 和 jiti 的宿主目录运行测试：

```bash
PI_REVIEW_HOST_ROOT=/path/to/pi-host node --test ./review.test.mjs
```

覆盖参数解析、补充要求传递、JSONL 长行分页、模型与思考强度、true/false 报告投递、非法标记、取消、错误传播及配置重新读取。

参考官方文档：[扩展接口](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[Pi 包格式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。

## 友情链接

- [LINUX DO - 新的理想型社区](https://linux.do/)
