// Incrementally turn a stream of assistant text deltas into complete,
// speakable sentences so read-aloud can start mid-generation instead of
// waiting for the whole reply. Buffers text, flushes on sentence boundaries,
// and never emits a partial fenced code block (we hold everything from an
// unclosed ``` onward until the fence closes, then it collapses via toSpeakable).

// End of a sentence: terminal punctuation (optionally followed by a closing
// quote/bracket) that is itself followed by whitespace or end-of-buffer, OR a
// blank line (paragraph break).
const SENTENCE_BOUNDARY = /[.!?…]+["')\]]?(?=\s|$)|\n\s*\n/g;

// Index of an unclosed ``` fence (odd number of fences => the last one is
// still open), or -1 if all fences are balanced.
function unclosedFenceIndex(s: string): number {
	const positions: number[] = [];
	const re = /```/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) positions.push(m.index);
	return positions.length % 2 === 1 ? positions[positions.length - 1] : -1;
}

// Offset just past the last sentence boundary in `s`, or 0 if none is complete.
function lastBoundary(s: string): number {
	SENTENCE_BOUNDARY.lastIndex = 0;
	let idx = 0;
	let m: RegExpExecArray | null;
	while ((m = SENTENCE_BOUNDARY.exec(s)) !== null) idx = m.index + m[0].length;
	return idx;
}

export class SentenceStreamer {
	private buffer = "";

	// Feed a text delta; return any newly-complete chunks ready to speak.
	push(delta: string): string[] {
		this.buffer += delta;
		const out: string[] = [];
		const fence = unclosedFenceIndex(this.buffer);
		if (fence === -1) {
			// No open fence: flush every complete sentence, keep the trailing
			// (still-forming) fragment buffered.
			const b = lastBoundary(this.buffer);
			if (b > 0) {
				out.push(this.buffer.slice(0, b));
				this.buffer = this.buffer.slice(b);
			}
		} else if (fence > 0) {
			// Text before an unclosed fence is settled (nothing will be inserted
			// ahead of the fence), so flush it now; keep the open fence onward.
			out.push(this.buffer.slice(0, fence));
			this.buffer = this.buffer.slice(fence);
		}
		return out;
	}

	// End of stream: return whatever remains (including any dangling code block).
	flush(): string[] {
		const rest = this.buffer;
		this.buffer = "";
		return rest.trim() ? [rest] : [];
	}

	reset(): void {
		this.buffer = "";
	}
}
