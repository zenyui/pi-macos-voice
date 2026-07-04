// Turn agent markdown into something worth reading aloud: drop code blocks,
// inline code, urls, and markdown noise; collapse whitespace; cap length.

const MAX_CHARS = 700;

export function toSpeakable(text: string): string {
	let t = text;

	// Fenced code blocks -> a short placeholder (don't read code aloud).
	t = t.replace(/```[\s\S]*?```/g, " (code omitted) ");
	// Inline code -> keep the words, drop the backticks.
	t = t.replace(/`([^`]+)`/g, "$1");
	// Images / links -> keep the visible text.
	t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
	t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	// Bare urls.
	t = t.replace(/https?:\/\/\S+/g, " (link) ");
	// Headings / list / emphasis markers.
	t = t.replace(/^#{1,6}\s+/gm, "");
	t = t.replace(/^[\s]*[-*+]\s+/gm, "");
	t = t.replace(/[*_~]{1,3}/g, "");
	// Collapse whitespace.
	t = t.replace(/\s+/g, " ").trim();

	if (t.length > MAX_CHARS) {
		t = `${t.slice(0, MAX_CHARS).replace(/\s+\S*$/, "")}…`;
	}
	return t;
}
