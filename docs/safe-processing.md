# Safe bookmark processing

AI processing is **off by default**, including for older configs that set
`autoInvokeClaude: true`. `aiEnabled` must explicitly be `true` before a model
can run. The current local Haiku configuration therefore does not cause calls.
Fetches do not use an LLM. `node src/cli.js status` displays the cost gate.
Scheduled runs continue fetching into a nonempty queue while AI is disabled.

## Current workflow

1. Fetch with `node src/cli.js fetch --all --max-pages 100`. This retains every
   bookmark returned within that page bound; it is not a guarantee that X returned
   the entire account history. Without `--all`, the requested count caps results.
2. Leave AI disabled until a suitable provider/model is configured. Then use
   `node src/cli.js run --limit 5`. The default limit is also five, including after
   a fresh fetch. A run handles one batch; it does not drain the queue in a loop.
3. The runner writes a separate `.state/batch-*/input.json`. The selected model
   writes only `output.json` with draft entries and optional notes. It no longer
   receives the old `/process-bookmarks` workflow, uses Haiku subagents, or
   commits/pushes the results. Claude runs in bare/restricted mode with only Read/Write
   tools, from the batch directory. This requires a CLI supporting those flags;
   unsupported versions fail without acknowledging the batch. OpenCode uses a
   dedicated agent denying all tools except reading input and writing output,
   configured using its [documented permission rules](https://opencode.ai/docs/permissions/).
4. Node validates each primary Tweet ID, heading and summary. It writes notes to
   configured category folders using bookmark IDs as filenames, preserves existing
   archive text, and removes only validated entries from the master queue.
5. Partial output returns a failure status with the verified count. Unfinished
   bookmarks remain pending. Batches are retained for inspection; retrying does not
   depend on an old model conversation. Validation checks structure and IDs, not
   the factual quality of an AI summary.

## Free models and cost control

There is no implicit OpenCode model fallback. To use OpenCode later, set `cliTool`
to `opencode` and `opencodeModel` to an explicitly chosen supported model, then
enable `aiEnabled` only after confirming that provider's current billing terms.
The old `opencode/glm-4.7-free` default has been removed: a model name is not a
durable guarantee of free service. No model is automatically downloaded or chosen.

A local model is another possible route, but requires a local inference service
and an OpenCode provider configuration. This change does not install one. The gate
prevents accidental runs; it does not verify a provider's price once enabled.

Do not use the legacy `/process-bookmarks` command as a shortcut: it bypasses the
runner's gate and validation. The `process` CLI command currently shows pending
status and directs you to `run`; it does not invoke a model itself.

## Recovery and concurrent runs

All queue writers take an exclusive `<pendingFile>.lock`; a second process fails
without writing. A lock is never expired merely because time passed. After a hard
crash, inspect the PID in the lock and confirm it has stopped before manually
removing the lock. On restart, legacy `.full` backups are merged before processing.
Malformed queues/backups are preserved and require repair, rather than being reset.

Queue and archive replacements use temporary files and rename. If interrupted
after the archive is saved but before queue acknowledgement, existing primary
Tweet fields prevent reprocessing. A conflicting existing note is never replaced;
its bookmark stays pending. A crash before archive commit can leave an orphan note;
identical notes are reusable, while differing ones require inspection.

Explicit `fetch --force` and selected-ID fetches persist a reprocessing token.
Validated refreshes attach updated context to the existing entry and save optional
notes under a token-specific filename. A receipt in the archive prevents repeating
that refresh after a crash between saving the archive and acknowledging the queue.
Zero-count failures still send configured failure notifications.

These protections coordinate Smaug processes, not arbitrary external editors.
Avoid editing archive files while a run is committing output. Keep regular backups;
atomic rename is not a power-loss durability guarantee.

## Tests

`npm test` uses mocked AI, Bird and HTTP responses; it makes no model calls.
Live X integration tests require explicit `SMAUG_LIVE_TESTS=1`. No live provider
compatibility or summary-quality claim follows from the mocked tests.
