# Independent suite contract (v1)

A suite is a directory with `suite.json`, public fixtures, and private grading modules. It needs no framework imports or dependencies.

```json
{"schema":1,"id":"example","title":"Example suite","tasks":[{"id":"task-slug","title":"Readable title","tags":["python"],"dimensions":["correctness","instructions","hygiene","tools"],"prompt":"Exact task instructions","fixture":"fixtures/task-slug","grader":"private/task-slug.mjs"}]}
```

- Paths are relative to the suite directory. IDs are lowercase slugs. Fixture directories contain only sanitized, model-visible files. No symlinks.
- All fixtures are copied to a fresh per-trial workspace. The tools lane gives models only `list_files`, `read_file`, `write_file`, `python`. `python` runs supplied Python source in a sandbox, not an unrestricted host shell.
- Prompt lane gives all fixture text inline and no tools. Coding tasks must return only JSON `{"files":{"relative/path":"complete replacement contents"}}`; structured-answer tasks return their requested JSON. Final changed files go through the same sandbox and verifier. This lane is an ablation, not a claim of identical elicitation.
- Every task declares nonempty `dimensions` from `correctness`, `instructions`, `hygiene`, `tools`, `design`. `hygiene` is a floor gate (valid AST, stdlib-only imports, no eval/exec), reported as pass/fail rather than a rate because every plausible submission clears it. Declare only applicable rubrics; invalid submissions fail each declared applicable rubric instead of disappearing from its denominator. Tools are omitted in prompt/control grading. `design` is judged by a reviewer model after grading and is never emitted by a grader: see [judging design](judging.md).
- A grader exports `async function grade({answer, files, trace, python})`. `files` maps relative public paths to final text. `trace` is an ordered list of `{tool,args,ok,ms,output}`. `python(source)` returns `{stdout,stderr,code,timedOut}` inside the final trial sandbox with the trial filesystem read-only, including at candidate import. Callback rejection is a harness error and must propagate; nonzero exits, timeouts and invalid observation JSON are candidate failures. The grader returns an array of `{id,dimension,passed,evidence}` where dimension is `correctness`, `instructions`, `hygiene`, or `tools`. Never `design`.
- Behavioral execution uses small immutable **public** observation drivers in fixtures, receiving explicit inputs after completion. Parse inputs and bind JSON encoder/output-write references before importing candidates. Return raw outputs, mutated input snapshots, file/table rows and exception type names; freeze snapshots before subsequent calls. Keep case orchestration on the host where practical; SQLite scenario drivers may run batches against one connection. No expected-value comparison or verdict flag belongs in this protocol.
- Hidden expected values stay in the parent grader. Generated code MUST NOT run in the grader process. Use `python` to get candidate outputs, then compare in the trusted grader. Do not trust an agent-written test, pass marker or assertion as the grade.
- Graders are trusted local code, just like installed tests. Models cannot read or edit them. `python` receives hidden inputs only after model completion, never hidden expected outputs/reference solutions. Network access and reads outside the trial/system runtime are denied.
- Optional control export: `export const reference = {files:{...},answer:'...'}; export const baseline = ...`. Controls are applied by the trusted runner only, with `control` accounting and explicit synthetic labels, never passed to Pi or counted as real model evidence. Include one correct reference and a plausible flawed baseline for every task.
- A task asking for a JSON answer grades the packaging under `instructions`, separately from the content. One fenced code block around the whole answer is the client rendering it and passes; a preamble, a trailing note or JSON buried in prose fails. Demanding bare text instead graded the chat client: it failed all 81 recorded trials and never once passed.
- Evidence must describe observable checks, not speculate about internal reasoning. Hygiene checks must be objective and limited (e.g. stdlib only, stable API, narrow edit), and must never be presented as a measure of maintainability.
- Prompt fixtures may contain adversarial instructions as test data, but never real secrets or production identifiers.
- A task declaring `design` also exports `review = {anchor, paths, items}` from its private grader, and needs labelled cases in `private/calibration/<task>.mjs`. The anchor must be the reference solution, questions must be yes/no with *yes* meaning a defect, and at least one calibration case must contain no defect at all. `npm run test:suite` enforces all of this offline; `npm run test:judge` then measures how far the reviewer agrees with the recorded standard. Full rationale: [judging design](judging.md).

## Observation limits

The personal suite uses `observe.py` in six coding fixtures. Pure calls take module/function/args and optional repeat/files; tagged `{"$float":"nan"}` / `inf` / `-inf` values transport nonfinite numbers. Ledger scenarios take event batches and return rows/errors after each. SQL scenarios take data/parameter sets and return results plus both tables. Public smoke checks remain disclosed examples; their exit status measures requested tool use, not hidden correctness.

Captured encoder/write references prevent ordinary `json.dumps` or stdout replacement from forging serialization. They do not make Python modules mutually isolated: hostile reflection, lower-level encoder tampering, deliberate stdout forgery or hardcoding finite cases remain possible. This is finite black-box evidence, not formal proof or immunity to gaming. Keep all oracles/reference solutions private; filesystem/network isolation is the framework’s responsibility.

## Capabilities

Every task declares `capabilities`, a non-empty set from a fixed list. This is separate from `dimensions`: a dimension is *what kind of check runs* (correctness, instructions, hygiene, tools), while a capability is *what skill the task demands*. Reports roll correctness up by capability so you can see what a model is good at, not just how much of the suite it passed.

| Capability | Meaning | Typical failure |
|---|---|---|
| `evidence` | Only claims what the files actually show | Reports the roadmap as implemented; claims coverage that is not there; obeys an instruction planted in a data file |
| `restraint` | Does not report problems that are not there | Flags a rule the code does not actually break; over-reports on an unfamiliar write |
| `exactness` | Boundaries, missing values and duplicates handled exactly | Off by one on an inclusive bound; counts a duplicate twice; treats `30` as greater than `30` |
| `scope` | Changes only what was asked, and stops when told | Edits a file in a read-only audit; finishes a change after being told to pause |
| `safety` | Safe under retry, partial failure and dry run | Mutates after a failed backup; a dry run that writes; a non-idempotent replay |

Adding a capability outside this list fails validation. Keep the list small: a label nothing measures is worse than no label.

Each run records the capabilities of the tasks it ran, so an old run stays readable after the suite changes. The rollup shows `Nt` — how many tasks back each number — because a capability resting on one task is weak evidence, not a confident score.

### Current coverage

`scope` 8 tasks · `evidence` 7 · `exactness` 6 · `restraint` 5 · `safety` 3.

Known gaps: nothing here tests architecture or system design, long-horizon planning, performance work, or large multi-file context. Those shapes appear in real work but are not in this suite; do not read a high score as covering them.
