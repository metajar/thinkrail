import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

/** Provider id shown in pi's model picker as `claude-code/<alias>`. */
export const CLAUDE_CODE_PROVIDER = "claude-code";
/** Custom API tag; the stream is served by `streamClaudeCode`, never by pi's built-in Anthropic client. */
export const CLAUDE_CODE_API = "claude-code-cli";
/** Non-secret placeholder: pi requires an apiKey when models are defined; the CLI's own login is the credential. */
const PLACEHOLDER_KEY = "claude-code-cli-login";

const MODELS: ProviderModelConfig[] = [
	{
		id: "sonnet",
		name: "Claude Sonnet (Claude Code subscription)",
		reasoning: false,
		input: ["text"],
		cost: zeroCost(),
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "opus",
		name: "Claude Opus (Claude Code subscription)",
		reasoning: false,
		input: ["text"],
		cost: zeroCost(),
		contextWindow: 200_000,
		maxTokens: 32_000,
	},
	{
		id: "haiku",
		name: "Claude Haiku (Claude Code subscription)",
		reasoning: false,
		input: ["text"],
		cost: zeroCost(),
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];

function zeroCost() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Resolve the claude binary: explicit override, then PATH, then the standard per-user install location. */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string {
	if (env.THINKRAIL_CLAUDE_BIN) return env.THINKRAIL_CLAUDE_BIN;
	const local = join(homedir(), ".local", "bin", "claude");
	const onPath = (env.PATH ?? "")
		.split(":")
		.filter(Boolean)
		.map((dir) => join(dir, "claude"))
		.find((candidate) => existsSync(candidate));
	return onPath ?? (existsSync(local) ? local : "claude");
}

/**
 * Environment for the child process. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed on purpose: if
 * present, the CLI bills the API key instead of the subscription this provider exists to use.
 */
export function childEnv(
	base: NodeJS.ProcessEnv,
	overlay?: Record<string, string>,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, ...overlay };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	return env;
}

const TOOL_OPEN = "<tool_call";
const TOOL_BLOCK = /<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/g;

function toolProtocol(tools: Tool[]): string {
	if (tools.length === 0) return "";
	const catalog = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	return [
		"",
		"# Tools",
		"The complete, authoritative set of tools for this session is listed below. Any other tool list earlier in this prompt is incomplete for this runtime; ignore it. Only the tools below can be called.",
		"To call one, write exactly this block and then stop writing:",
		'<tool_call name="TOOL_NAME">{"argument": "value"}</tool_call>',
		"The body must be one valid JSON object matching the tool's parameters. You may emit several blocks in one reply.",
		"After you emit tool calls, end your reply; the runtime executes them and returns results in the next message.",
		"Never invent tool results yourself.",
		"Available tools (JSON):",
		JSON.stringify(catalog),
	].join("\n");
}

function renderBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(
			(block: {
				type?: string;
				text?: string;
				thinking?: string;
				name?: string;
				arguments?: unknown;
			}) => {
				if (block.type === "text") return block.text ?? "";
				if (block.type === "toolCall")
					return `${TOOL_OPEN} name="${block.name}">${JSON.stringify(block.arguments ?? {})}</tool_call>`;
				return "";
			},
		)
		.filter(Boolean)
		.join("\n");
}

/** Flatten the non-system transcript into one prompt; each call is stateless, so the full history is resent. */
export function renderTranscript(messages: Message[], toolNames: string[] = []): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "user") parts.push(`[User]\n${renderBlocks(message.content)}`);
		else if (message.role === "assistant")
			parts.push(`[Assistant]\n${renderBlocks(message.content)}`);
		else if (message.role === "toolResult") {
			const body = renderBlocks(message.content);
			parts.push(`[Tool result: ${message.toolName}${message.isError ? " (error)" : ""}]\n${body}`);
		}
	}
	const reminder = toolNames.length
		? `(Write the next assistant reply now. Callable tools: ${toolNames.join(", ")}. If one of them can answer the request, emit a <tool_call> block for it instead of answering from memory.)`
		: "(Write the next assistant reply now.)";
	parts.push(`[Assistant]\n${reminder}`);
	return parts.join("\n\n");
}

/** Parse complete `<tool_call>` blocks out of finished reply text. */
export function parseToolCalls(
	text: string,
	allowed: Set<string>,
): { calls: ToolCall[]; remaining: string } {
	const calls: ToolCall[] = [];
	for (const match of text.matchAll(TOOL_BLOCK)) {
		const name = match[1] ?? "";
		const raw = (match[2] ?? "").trim();
		const call: ToolCall = {
			type: "toolCall",
			id: `cc_${Date.now().toString(36)}_${calls.length}`,
			name,
			arguments: {},
		};
		if (!allowed.has(name)) call.argumentsError = `Unknown tool "${name}".`;
		else {
			try {
				const parsed = JSON.parse(raw || "{}");
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) call.arguments = parsed;
				else call.argumentsError = "Tool arguments must be a JSON object.";
			} catch (error) {
				call.argumentsError = `Tool arguments were not valid JSON: ${(error as Error).message}`;
			}
		}
		calls.push(call);
	}
	return { calls, remaining: text.replace(TOOL_BLOCK, "").trim() };
}

interface CliEvent {
	type?: string;
	event?: {
		type?: string;
		index?: number;
		content_block?: { type?: string; id?: string; name?: string };
		delta?: { type?: string; text?: string; partial_json?: string };
	};
	is_error?: boolean;
	result?: string;
	subtype?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

/**
 * Stream one reply from `claude -p`. Text is streamed live until a tool-call block begins; the tail is held back
 * so markup never reaches the UI. Tool blocks are parsed from the complete reply at the end.
 */
export function streamClaudeCode(
	model: { id: string },
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const tools = getCurrentTools(context.messages);
	const allowed = new Set(tools.map((tool) => tool.name));
	const systemPrompt = [getCurrentSystemPrompt(context.messages), toolProtocol(tools)]
		.filter(Boolean)
		.join("\n");
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: CLAUDE_CODE_API,
		provider: CLAUDE_CODE_PROVIDER,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;

	const emit = (event: AssistantMessageEvent) => stream.push(event);
	const fail = (reason: "error" | "aborted", message: string) => {
		output.stopReason = reason;
		output.errorMessage = message;
		emit({ type: "error", reason, error: output });
		stream.end(output);
	};

	const run = async () => {
		emit({ type: "start", partial: output });
		const cwd = join(homedir(), ".thinkrail", "claude-code-provider");
		mkdirSync(cwd, { recursive: true });
		const args = [
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			model.id,
			"--system-prompt",
			systemPrompt,
			"--tools",
			"",
			"--no-session-persistence",
		];
		const posix = process.platform !== "win32";
		const child = spawn(resolveClaudeBinary(), args, {
			cwd,
			env: childEnv(process.env, options?.env),
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group on POSIX so a stop takes the CLI's helpers down with it and closes the pipes.
			detached: posix,
		});
		const stopChild = () => {
			try {
				if (posix && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill("SIGTERM");
			} catch {
				// Already exited.
			}
		};
		const onAbort = () => stopChild();
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.stdin.on("error", () => {});
		child.stdin.end(renderTranscript(context.messages, [...allowed]));

		let text = "";
		let streamedUpTo = 0; // chars of `text` already emitted to the UI
		let textStarted = false;
		let toolMarkupSeen = false;
		let finalText: string | undefined;
		let resultError: string | undefined;
		let usageIn: CliEvent["usage"];
		let buffered = "";
		// A native tool_use block: the model called a tool through the API channel instead of the text protocol.
		// Its name/arguments are captured and the CLI is stopped before its own loop answers with an error.
		let native:
			| { id: string; name: string; json: string; index: number; complete: boolean }
			| undefined;

		const pushText = (delta: string) => {
			if (toolMarkupSeen) return;
			buffered += delta;
			const markerAt = buffered.indexOf(TOOL_OPEN);
			let visible = markerAt >= 0 ? buffered.slice(0, markerAt) : buffered;
			if (markerAt < 0) {
				// Hold back a possible partial "<tool_call" at the end of the buffer.
				for (let keep = Math.min(TOOL_OPEN.length - 1, visible.length); keep > 0; keep--) {
					if (TOOL_OPEN.startsWith(visible.slice(-keep))) {
						visible = visible.slice(0, -keep);
						break;
					}
				}
			} else toolMarkupSeen = true;
			if (visible.length > streamedUpTo) {
				if (!textStarted) {
					textStarted = true;
					output.content.push({ type: "text", text: "" });
					emit({ type: "text_start", contentIndex: 0, partial: output });
				}
				const chunk = visible.slice(streamedUpTo);
				streamedUpTo = visible.length;
				(output.content[0] as { text: string }).text += chunk;
				emit({ type: "text_delta", contentIndex: 0, delta: chunk, partial: output });
			}
		};

		let lineBuffer = "";
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: CliEvent;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			const inner = event.type === "stream_event" ? event.event : undefined;
			if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
				const delta = inner.delta.text ?? "";
				text += delta;
				pushText(delta);
			} else if (
				inner?.type === "content_block_start" &&
				inner.content_block?.type === "tool_use" &&
				!native
			) {
				native = {
					id: inner.content_block.id ?? `cc_native_${Date.now().toString(36)}`,
					name: inner.content_block.name ?? "",
					json: "",
					index: inner.index ?? -1,
					complete: false,
				};
			} else if (
				inner?.type === "content_block_delta" &&
				inner.delta?.type === "input_json_delta" &&
				native &&
				inner.index === native.index
			) {
				native.json += inner.delta.partial_json ?? "";
			} else if (
				inner?.type === "content_block_stop" &&
				native &&
				inner.index === native.index &&
				!native.complete
			) {
				native.complete = true;
				stopChild();
			} else if (event.type === "result") {
				finalText = event.result;
				usageIn = event.usage;
				if (event.is_error || (event.subtype && event.subtype !== "success"))
					resultError = event.result ?? event.subtype;
			}
		};
		child.stdout.on("data", (chunk) => {
			lineBuffer += chunk.toString();
			let newline = lineBuffer.indexOf("\n");
			while (newline >= 0) {
				handleLine(lineBuffer.slice(0, newline));
				lineBuffer = lineBuffer.slice(newline + 1);
				newline = lineBuffer.indexOf("\n");
			}
		});

		const code = await new Promise<number | null>((resolve) => {
			child.on("error", (error) => {
				stderr += error.message;
				resolve(-1);
			});
			child.on("close", resolve);
		});
		options?.signal?.removeEventListener("abort", onAbort);
		handleLine(lineBuffer);

		if (options?.signal?.aborted) return fail("aborted", "Request aborted.");
		if (!native && (code !== 0 || resultError)) {
			const detail = (resultError ?? stderr.trim()) || `claude exited with code ${code}`;
			return fail("error", `Claude Code CLI failed: ${detail.slice(0, 500)}`);
		}

		// Some CLI versions omit partial events; fall back to the final result text.
		if (!text && finalText) {
			text = finalText;
			pushText(text);
		}
		const parsed = parseToolCalls(text, allowed);
		const calls: ToolCall[] = [];
		if (native?.complete) {
			const call: ToolCall = { type: "toolCall", id: native.id, name: native.name, arguments: {} };
			if (!allowed.has(native.name)) call.argumentsError = `Unknown tool "${native.name}".`;
			else {
				try {
					const parsedArgs = JSON.parse(native.json || "{}");
					if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs))
						call.arguments = parsedArgs;
					else call.argumentsError = "Tool arguments must be a JSON object.";
				} catch (error) {
					call.argumentsError = `Tool arguments were not valid JSON: ${(error as Error).message}`;
				}
			}
			calls.push(call);
		} else calls.push(...parsed.calls);
		const remaining = parsed.remaining;
		if (textStarted) {
			(output.content[0] as { text: string }).text = remaining;
			emit({ type: "text_end", contentIndex: 0, content: remaining, partial: output });
		} else if (remaining) {
			output.content.push({ type: "text", text: remaining });
			emit({ type: "text_start", contentIndex: 0, partial: output });
			emit({ type: "text_delta", contentIndex: 0, delta: remaining, partial: output });
			emit({ type: "text_end", contentIndex: 0, content: remaining, partial: output });
		}

		for (const call of calls) {
			const index = output.content.length;
			output.content.push(call);
			emit({ type: "toolcall_start", contentIndex: index, partial: output });
			emit({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: output });
		}

		const input = usageIn?.input_tokens ?? 0;
		const outputTokens = usageIn?.output_tokens ?? 0;
		const cacheRead = usageIn?.cache_read_input_tokens ?? 0;
		const cacheWrite = usageIn?.cache_creation_input_tokens ?? 0;
		output.usage = {
			input,
			output: outputTokens,
			cacheRead,
			cacheWrite,
			totalTokens: input + outputTokens + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} as AssistantMessage["usage"];
		output.stopReason = calls.length ? "toolUse" : "stop";
		emit({ type: "done", reason: output.stopReason, message: output });
		stream.end(output);
	};

	run().catch((error: unknown) =>
		fail("error", `Claude Code provider failed: ${(error as Error).message}`),
	);
	return stream;
}

export const claudeCodeProviderConfig = {
	name: "Claude Code (subscription)",
	baseUrl: "https://claude-code.local",
	apiKey: PLACEHOLDER_KEY,
	api: CLAUDE_CODE_API,
	models: MODELS,
	streamSimple: (
		model: Parameters<typeof streamClaudeCode>[0],
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => streamClaudeCode(model, context, options),
};

/** Registers the `claude-code` provider so models run through the local `claude` CLI login. */
export const claudeCodeProvider: ExtensionFactory = (pi: ExtensionAPI) => {
	pi.registerProvider(CLAUDE_CODE_PROVIDER, claudeCodeProviderConfig as never);
};

export default claudeCodeProvider;
