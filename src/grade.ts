import { pathToFileURL } from 'node:url';
import { DIMENSIONS } from './config.ts';
import { runPython } from './sandbox.ts';
import type { Check, Dimension, GradeContext, RunOptions, Task, Trial } from './types.ts';

/**
 * How a finished submission is graded: everything here reads what a try left behind and nothing
 * the model saw. It has its own fingerprint, so a change here regrades recorded tries from their
 * saved files instead of running the models again.
 */
export type Agent = 'pi' | 'claude-code';
export type Grader = { grade(context: GradeContext): Promise<Check[]> };
export const loadGrader = async (path: string) => await import(pathToFileURL(path).href) as Grader;
export function validateChecks(checks: unknown, dimensions?: Dimension[]): Check[] {
  if (!Array.isArray(checks) || !checks.length || checks.length > 100) throw new Error('Grader must return 1–100 checks');
  const ids = new Set<string>();
  for (const c of checks) {
    if (!c || typeof c.id !== 'string' || ids.has(c.id) || !DIMENSIONS.includes(c.dimension) || typeof c.passed !== 'boolean' || typeof c.evidence !== 'string' || c.evidence.length > 8000) throw new Error('Invalid/duplicate grader check');
    ids.add(c.id);
  }
  if (dimensions && (dimensions.some(d => !checks.some(c => c.dimension === d)) || checks.some(c => !dimensions.includes(c.dimension)))) throw new Error('Grader output does not match the declared task dimensions for this lane');
  return checks;
}
/**
 * What the deterministic grader must produce. The tool rubric names Forseti's own file tools, so
 * it grades the Pi lane only: the Claude Code lane reads and writes with its own, which Forseti
 * cannot observe. That is a process check, not a capability one — both lanes can run code, so
 * correctness stays comparable. `design` never appears here because it comes from the reviewer
 * model, which runs after grading and is appended separately.
 */
export function applicableDimensions(task: Task, lane: RunOptions['lane'], control: boolean, agent: Agent = 'pi'): Dimension[] {
  return task.dimensions.filter(d => d !== 'design' && (d !== 'tools' || (lane === 'tools' && !control && agent === 'pi')));
}
export function rejectArtifacts(trial: Trial, task: Task, lane: RunOptions['lane'], control: boolean, reason: string, agent: Agent = 'pi'): void {
  trial.error = [trial.error, `Invalid submission: ${reason}`].filter(Boolean).join('; ');
  if (!['passed', 'failed'].includes(trial.status)) return;
  trial.status = 'failed';
  trial.checks = applicableDimensions(task, lane, control, agent).map(dimension => ({ id: `invalid-submission-${dimension}`, dimension, passed: false, evidence: `Submission rejected before grading: ${reason}` }));
}
/** The grader's raw verdict on a submission; `work` holds its files, and graders read it only through the sandbox. */
export function gradeSubmission(grader: Grader, trial: Trial, lane: RunOptions['lane'], control: boolean, agent: Agent, work: string, signal: AbortSignal): Promise<Check[]> {
  return grader.grade({ lane, control, agent, answer: trial.answer, files: trial.files, trace: trial.trace, python: source => runPython(work, source, signal, 5000, true) });
}
