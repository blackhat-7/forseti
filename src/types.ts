/**
 * What kind of check ran.
 *
 * `hygiene` is a floor gate, not a score: valid AST, stdlib-only imports, no eval/exec. Every
 * plausible submission passes it, so it is reported as pass/fail and never as a percentage
 * beside correctness. It was called `quality` until 2026-09-18, which read as praise for
 * something never measured.
 *
 * `design` is the only judged dimension: it comes from a reviewer model rather than a
 * deterministic grader, so it is reported separately and never folded into correctness.
 */
export type Dimension = 'correctness' | 'instructions' | 'hygiene' | 'tools' | 'design';
export type Check = { id: string; dimension: Dimension; passed: boolean; evidence: string };
export type ToolEvent = { tool: string; args: Record<string, unknown>; ok: boolean; ms: number; output: string };
export type PythonResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean };
export type GradeContext = {
  lane: 'tools' | 'prompt';
  control: boolean;
  answer: string;
  files: Record<string, string>;
  trace: ToolEvent[];
  python: (source: string) => Promise<PythonResult>;
  /** Which agent produced the submission. The tool rubric only applies to Forseti's own harness. */
  agent?: 'pi' | 'claude-code';
};
/**
 * What skill a task demands, as opposed to `dimensions`, which is what kind of check runs.
 * evidence  - only claims what the files actually show
 * restraint - does not report problems that are not there
 * exactness - boundaries, missing values and duplicates handled exactly
 * scope     - changes only what was asked, and stops when told
 * safety    - safe under retry, partial failure and dry run
 */
export type Capability = 'evidence' | 'restraint' | 'exactness' | 'scope' | 'safety';
export type Task = { id: string; title: string; tags: string[]; dimensions: Dimension[]; capabilities: Capability[]; prompt: string; fixture: string; grader: string };
export type Suite = { schema: 1; id: string; title: string; tasks: Task[] };
export type ModelConfig = {
  id: string; label: string; provider: string; model: string;
  auth: 'pi' | 'env' | 'none' | 'cli'; enabled: boolean;
  thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};
/**
 * The reviewer model behind the `design` dimension. It is part of the harness, not a candidate:
 * changing it changes what the scores mean, so it is recorded in every run and enters the
 * comparison key. `repeat` judges each submission N times and takes the majority, which exposes
 * judge instability instead of hiding it.
 */
export type JudgeConfig = { enabled: boolean; provider: string; model: string; auth: 'pi' | 'env' | 'cli'; thinking: ModelConfig['thinking']; repeat: number };
/** The user's own OpenAI-compatible server, such as llama-server. Empty means none is configured. */
export type LocalConfig = { url: string };
export type Config = { schema: 1; suite: string; models: ModelConfig[]; disabledTests: string[]; removedTests: string[]; judge: JudgeConfig; local: LocalConfig };
export type AuthInfo = { mode: string; billing: 'subscription' | 'metered' | 'unknown' | 'control' | 'local'; ready: boolean; note: string };
export type RunOptions = { models?: string[]; tests?: string[]; repeat: number; seed: number; lane: 'tools' | 'prompt'; timeout: number; maxTurns: number; maxTokens: number; allowMetered: boolean; cache: boolean };
export type Trial = {
  id: string; model: string; task: string; repetition: number;
  status: 'passed' | 'failed' | 'auth_error' | 'rate_limited' | 'provider_error' | 'harness_error' | 'timeout' | 'budget' | 'cancelled' | 'skipped';
  auth: AuthInfo; checks: Check[]; error?: string;
  /** Why the reviewer produced no design checks. Never a model failure: the judge is harness. */
  judgeNote?: string;
  wallMs: number; modelMs: number; toolMs: number; gradeMs: number; firstTokenMs: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  estimatedCost: number | null;
  trace: ToolEvent[]; answer: string; files: Record<string, string>; turns: number;
};
export type Run = {
  schema: 1; id: string; created: string; finished?: string; status: 'running' | 'completed' | 'cancelled' | 'interrupted';
  suite: string; suiteHash: string; harnessHash: string; environment: Record<string, string>;
  judge: JudgeConfig | null;
  options: RunOptions; models: ModelConfig[]; tasks: { id: string; title: string; hash: string; capabilities?: Capability[] }[];
  planned: number; trials: Trial[];
};
export type Progress = { completed: number; total: number; model: string; task: string; phase: string; runId: string };
