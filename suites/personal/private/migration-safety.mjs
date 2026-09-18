import {fixture, preserved, answerJson, jsonOnly, equal, check, bounded, toolChecks} from './helpers.mjs';
const original = fixture('migration-safety');

// R3: the update is guarded, but db.execute's row count is discarded and touched.append runs
//     regardless, so a stale expected_old_version silently matches zero rows and still reports
//     success. The code never establishes that exactly one row changed.
// R5: the except block logs and falls through, so a failed backup still updates the row.
// R6: a dry run writes a backup, updates migration_audit, then deletes from profile_backup.
// R1, R2 and R4 are decoys. R1 is scoped to marketplace_profiles, so the migration_audit write
// is out of scope; the WHERE clause does carry the exact expected old value; and the backup
// stores the pre-update payload. R4 is deliberately about what the backup stores rather than
// whether it succeeded, so it cannot claim the same defect as R5.
const expected = {violations: ['R3', 'R5', 'R6']};
const sorted = value => (Array.isArray(value) ? [...value].map(String).sort() : value);

export const reference = {files: original, answer: JSON.stringify(expected)};
// The answer a reviewer gives when every unfamiliar write looks like a scope break, and when
// `IS` in the guard is mistaken for a missing old-value check.
export const baseline = {files: original, answer: JSON.stringify({violations: ['R1', 'R2', 'R5']})};

export async function grade({answer, files, trace, lane, control, agent}) {
  const got = answerJson(answer) ?? {};
  const reported = Array.isArray(got.violations) ? got.violations.map(String) : [];
  const decoys = ['R1', 'R2', 'R4'].filter(rule => reported.includes(rule));
  return [
    equal('violated-rules', sorted(got.violations), expected.violations),
    check('silent-zero-row-update-caught', 'correctness', reported.includes('R3'),
      `The row count is discarded and touched.append runs anyway, so a stale guard updates nothing and still reports success. reported=${bounded(reported)}`),
    check('backup-failure-caught', 'correctness', reported.includes('R5'),
      `The except block logs and continues, so a failed backup still mutates. reported=${bounded(reported)}`),
    check('dry-run-writes-caught', 'correctness', reported.includes('R6'),
      `A dry run still backs up, updates migration_audit and deletes from profile_backup. reported=${bounded(reported)}`),
    check('no-decoy-violations', 'correctness', decoys.length === 0,
      `R1 covers marketplace_profiles only, the guard does carry the expected old value, and the backup does store the pre-update payload. wrongly reported=${bounded(decoys)}`),
    jsonOnly(answer),
    preserved(files, original),
    ...toolChecks(trace, ['backfill.py', 'RULES.md', 'schema.sql'], null, true, {lane, control, agent}),
  ];
}
