# Native session readers

`createAgyReader` reads Antigravity CLI (`agy`, `antigravity`) JSONL from
`<home>/.gemini/antigravity-cli/brain/<session>/.system_generated/logs/transcript.jsonl`.
This format was verified read-only against live files on this machine. `USER_INPUT`
records provide user prose; `PLANNER_RESPONSE` provides assistant prose, thinking
status and tool names. `GENERIC` records provide status only: their opaque content
may be tool output. Calls have no native call IDs, so tool parts describe the
requested action as pending without claiming execution or pairing results. A planner
record marked `DONE` does not establish that its tools completed. Errors provide status only.
This is Antigravity's format, **not** Gemini CLI's separate JSON session format;
`gemini` is not auto-selected.

`createPiReader` reads Pi v3 session JSONL from
`<home>/.pi/agent/sessions/<encoded-project>/<session>.jsonl`, also verified against
live files. `message` entries map user/assistant prose, thinking status, `toolCall`
and `toolResult` blocks (paired by `toolCallId`), stop/error states. Metadata,
custom entries, system prompts and branch/compaction summaries are ignored.
These are append-order records; this reader does not reconstruct the active branch
of Pi's session tree. All checked-in fixtures are minimal synthetic data.

Both readers use the existing complete-line UTF-8 byte cursor and generation reset
rules, and are registered by `createReaders`. Their `includeText` option defaults
to `false`; `true` adds only user/assistant prose. Tool arguments, tool output,
thought content, signatures and error text are never emitted. Existing Claude,
Codex and plain-text readers retain their existing text behavior.

`discoverAgySessions({home})` and `discoverPiSessions({home})` return sorted native
session paths using directory entries only. Alternatively pass `{root}` to name
the Antigravity `brain` or Pi `sessions` directory directly (takes precedence over
`home`). A home or root must be injected; there is no implicit user home. Missing
roots return an empty list; symlink entries are excluded. Discovery does not open
transcripts. Callers read the discovered file and pass its suffix through the
existing `GenerationRecord` interface; the reader itself performs no file I/O.

For reader APIs and the file threat model, see [seat-readers](../packages/seat-readers/README.md).
