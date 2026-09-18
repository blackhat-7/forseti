# UI integration contract

Implement `src/tui.ts` exporting `Dashboard` (testable component) and `launchTui(app: App): Promise<void>`. Parent owns `src/app.ts` and backend.

`App` (import type from ./app.ts):
- `root: string`, `config: Config`, `suite: Suite`, `runs: Run[]`, `catalog: CatalogEntry[]` (public fields).
- `refresh(): Promise<void>` reload all state/catalog metadata without sending prompts.
- `persist(): void` validate/save `config` (changes in config mutable fields allowed).
- `run(options: RunOptions, onProgress: (p: Progress)=>void, signal: AbortSignal): Promise<Run>` executes enabled models/tests by default (explicit `models`/`tests` optional), updates app.runs afterwards.
- `compare(runIds: string[]): string` returns Markdown report for selected IDs (one run can include multiple models).
- `exportReport(runIds: string[]): string` saves same report under workspace `reports/` and returns workspace-relative path.
- `addModel(provider: string, model: string, auth: 'pi'|'env'|'none'): void` verifies model/catalog and adds config entry with safe unique id.
- `addTest(id: string, prompt: string, expectedJson: string): void` creates simple independent exact-JSON task/hidden grader in current suite and refreshes suite in memory.

`CatalogEntry` from ./app.ts is `{provider:string,id:string,name:string,auth:AuthInfo}`. Full config and result types are in src/types.ts. Runs sorted newest first.

Default RunOptions: `{repeat:2,seed:42,lane:'tools',timeout:90,maxTurns:12,maxTokens:4096,allowMetered:false,cache:true}`. User must explicitly confirm metered/unknown billing before setting allowMetered true. Show auth and billing in preflight. Controls clearly synthetic. No provider request on startup. Cancellation uses AbortController, partial results retained. No raw secrets/provider output ANSI on terminal (strip control characters).

UI expectations: calm dark terminal design — one accent colour for interaction, semantic colour elsewhere, no full-width rules or boxes, generous spacing, aligned label/value columns; header/navigation, responsive panels; Home/Models/Tests/Runs navigation with tab/1-4, arrow and j/k, clear footer shortcuts and help; selection/toggle/add/remove for models/tests; filtered catalog picker for model addition via existing Pi Input/SelectList; test add wizard prompt+expected JSON; confirmation before run/delete; repetitions/lane easy to change; clear live current task/progress; selected run comparisons with per-case evidence drilldown and report export. Ctrl+C/Esc cancels active run without losing results. Avoid huge custom UI frameworks. Native Pi TUI primitives. Test renders widths 40/80/120 and keyboard flows with mock App.
