import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessageEvent,
	type Message,
	normalizeContext,
	type Tool,
} from "@earendil-works/pi-ai";
import { childEnv, parseToolCalls, renderTranscript, streamClaudeCode } from "./claudeCodeProvider";

const readTool: Tool = {
	name: "read_note",
	description: "Read a note",
	parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } as never,
} as Tool;

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("parseToolCalls", () => {
	test("extracts valid calls and strips markup from the visible text", () => {
		const text = 'Let me check.\n<tool_call name="read_note">{"id":"a1"}</tool_call>';
		const { calls, remaining } = parseToolCalls(text, new Set(["read_note"]));
		expect(remaining).toBe("Let me check.");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("read_note");
		expect(calls[0]?.arguments).toEqual({ id: "a1" });
		expect(calls[0]?.argumentsError).toBeUndefined();
	});

	test("flags unknown tools and malformed JSON instead of guessing", () => {
		const { calls } = parseToolCalls(
			'<tool_call name="nope">{}</tool_call><tool_call name="read_note">{bad</tool_call>',
			new Set(["read_note"]),
		);
		expect(calls[0]?.argumentsError).toContain("Unknown tool");
		expect(calls[1]?.argumentsError).toContain("not valid JSON");
	});
});

describe("renderTranscript", () => {
	test("renders user, assistant, and tool results in order, skipping system messages", () => {
		const messages = [
			{ role: "system", content: "sys", timestamp: 0 },
			{ role: "user", content: "hi", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t", name: "read_note", arguments: { id: "a1" } }],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "read_note",
				content: [{ type: "text", text: "note body" }],
				isError: false,
				timestamp: 3,
			},
		] as unknown as Message[];
		const out = renderTranscript(messages);
		expect(out.indexOf("[User]\nhi")).toBeLessThan(
			out.indexOf("[Tool result: read_note]\nnote body"),
		);
		expect(out).not.toContain("sys");
		expect(out.endsWith("(Write the next assistant reply now.)")).toBe(true);
	});
});

describe("childEnv", () => {
	test("drops API-key variables so the CLI uses the subscription login", () => {
		const env = childEnv(
			{ ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_AUTH_TOKEN: "t", HOME: "/h" },
			{ FOO: "1" },
		);
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.HOME).toBe("/h");
		expect(env.FOO).toBe("1");
	});
});

describe("streamClaudeCode with a stand-in CLI", () => {
	test("streams text, emits a tool call, and stops with toolUse", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-fake-"));
		const bin = join(dir, "claude");
		const reply = 'Checking.<tool_call name="read_note">{"id":"a1"}</tool_call>';
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
cat > /dev/null
printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Checking."}}}'
printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"<tool_call name=\\"read_note\\">{\\"id\\":\\"a1\\"}</tool_call>"}}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":${JSON.stringify(reply)},"usage":{"input_tokens":5,"output_tokens":7}}'
`,
		);
		chmodSync(bin, 0o755);
		const prev = process.env.THINKRAIL_CLAUDE_BIN;
		process.env.THINKRAIL_CLAUDE_BIN = bin;
		try {
			const context = normalizeContext({
				systemPrompt: "You are a test.",
				messages: [{ role: "user", content: "read a1", timestamp: 1 }],
				tools: [readTool],
			});
			const events = await collect(streamClaudeCode({ id: "sonnet" }, context));
			const types = events.map((e) => e.type);
			expect(types[0]).toBe("start");
			expect(types).toContain("toolcall_end");
			const streamed = events
				.filter(
					(e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
						e.type === "text_delta",
				)
				.map((e) => e.delta)
				.join("");
			expect(streamed).toBe("Checking.");
			expect(streamed).not.toContain("tool_call");
			const done = events.at(-1);
			expect(done?.type).toBe("done");
			if (done?.type === "done") {
				expect(done.reason).toBe("toolUse");
				expect(done.message.usage.totalTokens).toBe(12);
			}
		} finally {
			if (prev === undefined) delete process.env.THINKRAIL_CLAUDE_BIN;
			else process.env.THINKRAIL_CLAUDE_BIN = prev;
		}
	});

	test("captures a native tool_use block as a tool call and stops the CLI before its own loop", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-fake-"));
		const bin = join(dir, "claude");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
cat > /dev/null
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_note","input":{}}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a1\\"}"}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
sleep 30
printf '%s\n' '{"type":"user","message":"should never be read"}'
`,
		);
		chmodSync(bin, 0o755);
		process.env.THINKRAIL_CLAUDE_BIN = bin;
		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "read a1", timestamp: 1 }],
				tools: [readTool],
			});
			const started = Date.now();
			const events = await collect(streamClaudeCode({ id: "haiku" }, context));
			expect(Date.now() - started).toBeLessThan(10_000);
			const done = events.at(-1);
			expect(done?.type).toBe("done");
			if (done?.type === "done") {
				expect(done.reason).toBe("toolUse");
				const call = done.message.content.find((block) => block.type === "toolCall");
				expect(call).toMatchObject({
					type: "toolCall",
					id: "toolu_1",
					name: "read_note",
					arguments: { id: "a1" },
				});
			}
		} finally {
			delete process.env.THINKRAIL_CLAUDE_BIN;
		}
	});

	test("reports a CLI failure as an error event", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-fake-"));
		const bin = join(dir, "claude");
		writeFileSync(bin, "#!/usr/bin/env bash\necho 'Not logged in' >&2\nexit 1\n");
		chmodSync(bin, 0o755);
		process.env.THINKRAIL_CLAUDE_BIN = bin;
		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			});
			const events = await collect(streamClaudeCode({ id: "sonnet" }, context));
			const last = events.at(-1);
			expect(last?.type).toBe("error");
			if (last?.type === "error") expect(last.error.errorMessage).toContain("Not logged in");
		} finally {
			delete process.env.THINKRAIL_CLAUDE_BIN;
		}
	});
});

const live = process.env.CLAUDE_CODE_LIVE === "1";
test.skipIf(!live)("live: round-trips through the logged-in claude CLI", async () => {
	const context = normalizeContext({
		systemPrompt: "Reply with exactly the word pong and nothing else.",
		messages: [{ role: "user", content: "ping", timestamp: 1 }],
	});
	const events = await collect(streamClaudeCode({ id: "haiku" }, context));
	const last = events.at(-1);
	expect(last?.type).toBe("done");
	if (last?.type === "done")
		expect(JSON.stringify(last.message.content).toLowerCase()).toContain("pong");
});
