import { defineServerExtension } from "@thinkrail/extension-api/server";
import claudeCodeProvider from "./claudeCodeProvider.js";

export default defineServerExtension({
	name: "claude-code",
	title: "Claude Code subscription",
	description:
		"Lets ThinkRail run models through your local Claude Code CLI login, so a Claude subscription (Pro/Max) can be used instead of an API key.",
	extensions: [claudeCodeProvider],
});
