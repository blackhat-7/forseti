import {isDeepStrictEqual} from 'node:util';
import {fixture, preserved, observeCases, check, bounded, toolChecks, pythonHygiene} from './helpers.mjs';
const original = fixture('lock-refresh');

const REFERENCE = `"""Pick one version of every package in the lockfile."""


def parse_version(text):
    return tuple(int(part) for part in text.split("."))


def satisfies(version, spec):
    """True when version meets every comma-separated clause: >=X, <X, ==X or !=X."""
    have = parse_version(version)
    for clause in spec.split(","):
        clause = clause.strip()
        for op in (">=", "==", "!=", "<"):
            if clause.startswith(op):
                want = parse_version(clause[len(op):].strip())
                break
        else:
            raise ValueError(f"unknown clause {clause!r}")
        if op == ">=" and not have >= want:
            return False
        if op == "<" and not have < want:
            return False
        if op == "==" and have != want:
            return False
        if op == "!=" and have == want:
            return False
    return True


def resolve(manifest, index):
    names = list(manifest)
    where = {name: i for i, name in enumerate(names)}
    # Newest first, so bit 0 of a domain is always the most preferred version left.
    versions = [sorted(index[name], key=parse_version, reverse=True) for name in names]
    full = [(1 << len(v)) - 1 for v in versions]
    # support[i][j][a]: the versions of j that can sit beside version a of i, both ways round.
    support = [{} for _ in names]
    for i, name in enumerate(names):
        for a, version in enumerate(versions[i]):
            for other, spec in index[name][version].items():
                j = where[other]
                ok = sum(1 << b for b, w in enumerate(versions[j]) if satisfies(w, spec))
                for x, y, p, q in ((i, j, a, None), (j, i, None, a)):
                    table = support[x].setdefault(y, [full[y]] * len(versions[x]))
                    if p is not None:
                        table[p] &= ok
                    else:
                        for b in range(len(versions[j])):
                            if not ok >> b & 1:
                                table[b] &= ~(1 << q)

    def propagate(domains, queue):
        # Arc consistency: drop any version with no partner left in a neighbour's domain.
        pending = set(queue)
        while queue:
            x = queue.pop()
            pending.discard(x)
            for y, table in support[x].items():
                back = support[y][x]
                dom = domains[y]
                kept = dom
                rest = dom
                while rest:
                    bit = rest & -rest
                    rest ^= bit
                    if not back[bit.bit_length() - 1] & domains[x]:
                        kept ^= bit
                if kept != dom:
                    if not kept:
                        return False
                    domains[y] = kept
                    if y not in pending:
                        pending.add(y)
                        queue.append(y)
        return True

    def search(i, domains):
        if i == len(names):
            return domains
        rest = domains[i]
        while rest:
            bit = rest & -rest
            rest ^= bit
            trial = list(domains)
            trial[i] = bit
            if propagate(trial, [i]):
                found = search(i + 1, trial)
                if found:
                    return found
        return None

    domains = list(full)
    if not propagate(domains, list(range(len(names)))):
        return None
    found = search(0, domains)
    if found is None:
        return None
    return {name: versions[i][found[i].bit_length() - 1] for i, name in enumerate(names)}
`;
export const reference = {files: {...original, 'resolver.py': REFERENCE}, answer: 'Search the packages in priority order, dropping releases that can no longer fit before going deeper.'};
// The fixture's own starting code: newest release that fits what is already picked, never revisited. It passes check_public.py.
export const baseline = {files: original, answer: 'Picked the newest compatible release of each package in priority order.'};

/**
 * The public registries are arranged so the obvious resolver is right on them: the newest release
 * that fits the packages already picked always turns out to be part of a full set. Hidden cases:
 *   small      — random registries where that greedy pick is right, some with no resolution at all.
 *   backtrack  — random registries where the greedy pick dead-ends later although a set exists,
 *                often one where the top-priority package itself must step back from its newest.
 *   large      — up to 50 packages with up to 30 releases. Backtracking that only compares a
 *                candidate with the packages already picked retries every combination of the
 *                packages in between before it reaches the conflict, and runs out of CPU.
 * Every expected value came from the reference and was cross-checked against an exhaustive search
 * (small and backtrack) or against independent solvers (large).
 */
const SMALL = [
  [["atlas","quill"],{"atlas":{"1.9.0":{},"1.10.2":{},"1.10.0":{}},"quill":{"3.0.0":{"atlas":"<1.10.2"},"2.4.0":{}}},{"atlas":"1.10.2","quill":"2.4.0"}],
  [["gauge","tally","ingot","kiln","hinge","harbor","sprout"],{"gauge":{"3.0.1":{"tally":"!=0.10.0","kiln":"!=1.0.1","hinge":">=0.5.0"},"3.0.0":{"tally":"==1.0.0","ingot":">=1.5.0","harbor":">=0.2.0, <1.0.0","sprout":"!=0.7.0"},"3.0.2":{"tally":">=0.10.0, <1.0.0","hinge":">=0.4.1","sprout":"!=0.7.0"},"2.0.0":{"tally":">=0.11.0","kiln":">=1.0.1, <2.0.0","harbor":">=0.2.0, <1.0.0"}},"tally":{"0.9.0":{"gauge":">=3.0.2"},"0.10.0":{"hinge":">=0.4.2","harbor":"!=0.2.0","sprout":">=0.7.0, <0.8.0"},"0.11.0":{"gauge":">=3.0.1","hinge":"==1.0.0","sprout":"!=0.8.0"},"1.0.0":{"gauge":">=2.0.0","ingot":"==1.7.0","hinge":"<0.4.1"},"0.8.0":{"hinge":"!=1.0.0"}},"ingot":{"1.8.0":{"tally":"!=0.9.0"},"1.5.1":{"gauge":"<3.0.1","tally":">=0.10.0, <0.11.0","kiln":">=1.0.0"},"1.6.0":{"gauge":">=3.0.0","tally":">=0.8.0","hinge":">=0.4.1","harbor":"!=0.2.0"},"1.7.0":{"gauge":"==3.0.2","harbor":"!=0.2.0"},"1.5.0":{"gauge":"!=3.0.1","sprout":"!=0.8.0"}},"kiln":{"1.0.1":{"hinge":">=0.4.0, <0.5.0","sprout":">=0.7.0"},"1.0.0":{"gauge":"!=2.0.0","tally":"!=0.11.0","hinge":">=0.4.0, <0.4.2","harbor":">=1.0.0","sprout":">=0.7.0"},"2.0.0":{"gauge":">=2.0.0","ingot":">=1.5.0, <1.8.0","harbor":">=1.0.0","sprout":"!=0.7.0"}},"hinge":{"0.4.0":{"gauge":">=2.0.0","tally":"==0.8.0","ingot":"==1.6.0","harbor":"!=0.2.0","sprout":">=0.8.0"},"0.5.0":{"ingot":"==1.7.0","harbor":"<1.0.0","sprout":"!=0.7.0"},"1.0.0":{"gauge":"<3.0.0","ingot":"!=1.7.0","kiln":">=1.0.0","sprout":"==0.8.0"},"0.4.2":{"gauge":"==3.0.0","sprout":">=0.8.0"},"0.4.1":{"gauge":"!=3.0.0","tally":"<1.0.0","ingot":">=1.6.0","harbor":">=1.0.0"}},"harbor":{"0.2.0":{"ingot":">=1.5.1","kiln":">=1.0.0, <1.0.1"},"1.0.0":{"tally":"==1.0.0","ingot":"!=1.8.0","kiln":"!=1.0.0"}},"sprout":{"0.7.0":{"ingot":">=1.5.1, <1.6.0","kiln":"<1.0.1","hinge":"==0.4.2","harbor":"!=0.2.0"},"0.8.0":{"gauge":"!=3.0.2","kiln":"<2.0.0","hinge":">=0.4.0"}}},null],
  [["hinge","harbor","courier","ingot","ledger","sprout"],{"hinge":{"1.8.0":{"harbor":">=2.8.0, <2.9.0"},"1.9.0":{"courier":">=1.0.0, <1.1.0","ledger":">=2.2.0, <3.0.0","sprout":"!=2.7.0"},"2.0.0":{"courier":">=1.1.0","ingot":">=2.9.1","sprout":"!=2.7.0"}},"harbor":{"2.8.0":{"ingot":">=2.10.0, <3.0.0","ledger":">=2.2.0"},"2.9.0":{"hinge":"!=1.9.0","sprout":"!=2.8.0"}},"courier":{"1.1.0":{"harbor":">=2.8.0"},"1.0.0":{"harbor":"!=2.8.0","ingot":">=2.11.0","ledger":">=3.0.0, <3.2.0","sprout":"!=2.7.0"},"0.4.0":{"hinge":"==2.0.0","harbor":">=2.8.0","ingot":"==2.10.0","ledger":"!=3.0.0","sprout":"!=2.8.0"},"2.0.0":{"harbor":"==2.8.0","sprout":">=2.7.0, <2.8.0"}},"ingot":{"3.0.0":{"hinge":">=1.9.0","harbor":">=2.9.0","ledger":">=3.2.0","sprout":"!=2.7.0"},"2.11.0":{"harbor":"!=2.9.0","courier":">=1.1.0, <2.0.0"},"2.10.0":{"hinge":"==1.9.0","harbor":"!=2.9.0","courier":">=1.1.0","sprout":">=2.7.0"},"2.9.0":{"sprout":">=2.7.0, <2.8.0"},"2.9.1":{"harbor":"!=2.9.0","courier":">=1.1.0, <2.0.0","ledger":">=2.2.0"}},"ledger":{"3.1.0":{"harbor":"!=2.9.0","sprout":"!=2.8.0"},"3.2.0":{"hinge":"!=2.0.0","harbor":">=2.9.0","sprout":"==2.7.0"},"3.0.1":{"hinge":"!=1.8.0","harbor":"!=2.9.0"},"2.2.0":{"courier":"==0.4.0"},"3.0.0":{"hinge":">=1.8.0","ingot":">=2.9.1"}},"sprout":{"2.8.0":{"courier":"==1.0.0","ledger":"!=2.2.0"},"2.7.0":{"hinge":"!=1.8.0","harbor":"!=2.8.0","courier":"==1.1.0","ingot":">=2.9.0"}}},null],
  [["sprout","dock","ingot"],{"sprout":{"2.1.0":{},"2.0.0":{},"2.3.0":{"dock":"<0.1.1"},"2.2.0":{}},"dock":{"0.3.0":{"sprout":"!=2.2.0"},"0.1.0":{"ingot":">=3.0.0"},"0.2.0":{"sprout":">=2.1.0, <2.3.0"},"0.1.1":{"sprout":"!=2.1.0","ingot":">=2.8.0, <2.9.0"}},"ingot":{"2.8.0":{"dock":">=0.1.0"},"2.10.0":{},"2.9.0":{},"2.11.0":{"sprout":"==2.1.0"},"3.0.0":{}}},{"sprout":"2.3.0","dock":"0.1.0","ingot":"3.0.0"}],
  [["dock","beacon","harbor","atlas"],{"dock":{"1.8.0":{},"1.8.1":{},"1.7.0":{}},"beacon":{"3.0.0":{"atlas":"==2.6.0"},"2.9.0":{"harbor":"!=2.0.0"},"2.9.1":{},"2.10.0":{}},"harbor":{"1.8.0":{"beacon":">=2.9.0, <2.9.1","atlas":">=2.7.0"},"2.0.0":{},"1.8.1":{"beacon":">=2.9.1, <3.0.0"}},"atlas":{"2.10.0":{"dock":"!=1.7.0"},"2.6.0":{},"2.8.0":{"beacon":"!=3.0.0"},"2.9.0":{"beacon":"!=2.9.0"},"2.7.0":{}}},{"dock":"1.8.1","beacon":"3.0.0","harbor":"2.0.0","atlas":"2.6.0"}],
  [["kiln","fable","ledger","ingot","courier","quill","prism"],{"kiln":{"3.0.0":{"fable":"!=1.4.1","ledger":"!=2.2.0"},"2.8.0":{},"4.0.0":{"quill":">=0.9.0, <0.10.1"},"2.9.0":{},"2.7.0":{"fable":"!=1.4.1"}},"fable":{"1.5.0":{"quill":">=0.10.0"},"1.4.0":{"ledger":">=3.0.0"},"1.4.1":{"kiln":">=2.8.0"}},"ledger":{"3.0.0":{"kiln":">=2.9.0","fable":">=1.4.0"},"2.2.0":{"quill":"!=0.9.0","prism":"!=0.4.1"}},"ingot":{"1.3.0":{"ledger":"!=2.2.0","quill":">=0.10.0"},"1.4.0":{}},"courier":{"1.0.0":{"kiln":"<2.9.0","ledger":">=2.2.0","ingot":"<1.4.0"},"1.0.2":{"ingot":">=1.4.0"},"0.1.0":{},"1.0.1":{}},"quill":{"0.10.1":{},"0.10.0":{},"0.9.0":{}},"prism":{"0.4.0":{},"0.4.2":{"ledger":"!=3.0.0"},"0.3.0":{"fable":"<1.5.0","quill":">=0.9.0, <0.10.1"},"0.4.1":{"ledger":"!=3.0.0"}}},{"kiln":"4.0.0","fable":"1.5.0","ledger":"3.0.0","ingot":"1.4.0","courier":"1.0.2","quill":"0.10.0","prism":"0.4.0"}],
  [["fable","beacon","prism","gauge","quill","harbor","courier"],{"fable":{"2.0.0":{"quill":"!=0.3.0"},"2.1.0":{"beacon":"<1.2.0","prism":"!=2.4.2","gauge":">=2.4.0, <2.4.2"},"0.4.0":{"prism":">=2.4.0","gauge":">=2.4.0","harbor":"!=1.1.0","courier":"!=1.5.2"},"1.0.0":{"courier":"==1.5.2"},"1.0.1":{"beacon":">=1.0.0","gauge":">=2.4.1"}},"beacon":{"1.0.0":{"fable":">=2.0.0","harbor":">=0.3.0"},"1.2.0":{"prism":"!=2.4.1","gauge":"!=2.4.1","harbor":"!=1.2.0"},"0.7.0":{"courier":">=1.5.0"},"1.2.1":{"prism":"!=2.4.0","gauge":">=2.4.1","harbor":">=0.3.0"},"1.1.0":{}},"prism":{"2.4.1":{"gauge":"!=2.4.0","harbor":"!=0.3.0"},"2.4.2":{"beacon":"!=1.0.0","gauge":"<2.4.2","courier":"<1.5.1"},"2.4.0":{"fable":"==1.0.1","harbor":">=0.3.0"}},"gauge":{"2.4.1":{"fable":">=1.0.0"},"2.4.2":{"fable":">=0.4.0, <1.0.0","beacon":">=1.1.0, <1.2.0","quill":"!=0.2.0","harbor":">=1.0.0","courier":"<1.5.2"},"2.4.0":{"beacon":">=1.0.0","prism":"!=2.4.1"}},"quill":{"0.2.0":{"beacon":">=1.0.0, <1.2.1","courier":"==1.5.1"},"0.3.0":{"beacon":"!=1.2.1"}},"harbor":{"1.0.0":{"beacon":">=1.1.0","gauge":"!=2.4.2"},"1.1.0":{"gauge":">=2.4.0, <2.4.2","quill":"!=0.3.0"},"1.2.0":{"beacon":">=1.0.0"},"0.3.0":{"fable":">=0.4.0, <2.1.0","beacon":">=1.1.0","quill":"!=0.3.0","courier":"!=1.5.2"}},"courier":{"1.5.0":{},"1.5.3":{"prism":"!=2.4.1","harbor":"!=1.1.0"},"1.5.1":{"prism":">=2.4.1"},"1.5.2":{"quill":"!=0.2.0","harbor":">=1.0.0"}}},{"fable":"2.1.0","beacon":"1.1.0","prism":"2.4.1","gauge":"2.4.1","quill":"0.3.0","harbor":"1.2.0","courier":"1.5.2"}],
  [["dock","ingot","harbor","courier","quill","sprout","gauge"],{"dock":{"0.10.0":{"harbor":">=1.2.0, <2.0.0","sprout":">=2.5.0"},"0.9.1":{"ingot":">=2.3.0","harbor":"<2.0.0","quill":"==1.1.0"},"0.8.0":{"ingot":">=2.3.1","harbor":"<2.0.0","courier":"!=3.0.0"},"0.9.0":{"harbor":">=1.1.0"},"0.10.1":{"courier":"==3.0.0"}},"ingot":{"2.4.0":{"dock":"!=0.9.0","harbor":"==1.1.0","sprout":">=2.5.0"},"3.0.0":{"dock":"==0.10.0","harbor":">=1.2.0"},"3.1.0":{"dock":">=0.10.0","courier":"!=2.5.0","quill":"!=1.0.0","sprout":"!=2.6.1"},"2.3.1":{},"2.3.0":{"dock":"!=0.10.1","courier":"!=3.0.0"}},"harbor":{"1.1.0":{"dock":"!=0.8.0","sprout":">=2.5.0"},"1.2.0":{},"2.0.0":{"dock":"<0.10.1","sprout":"!=2.6.1"}},"courier":{"2.5.0":{"dock":"<0.9.0","harbor":">=1.1.0, <1.2.0","quill":"!=2.0.0","gauge":"!=1.7.0"},"3.0.0":{"ingot":">=2.3.0","harbor":">=1.2.0, <2.0.0","gauge":"<1.8.0"}},"quill":{"1.1.0":{"harbor":">=2.0.0","courier":"!=2.5.0","gauge":"!=1.8.0"},"2.0.1":{"ingot":"<2.3.1","harbor":"!=1.2.0","courier":">=2.5.0","gauge":">=1.7.0, <1.8.0"},"2.0.0":{"dock":"!=0.9.0","ingot":">=2.3.1"},"1.0.0":{"ingot":"!=2.3.1","harbor":"!=1.2.0","courier":"!=3.0.0"}},"sprout":{"2.6.1":{"harbor":"==1.1.0","quill":"!=1.0.0"},"2.6.0":{},"2.5.0":{"dock":"<0.10.0","harbor":">=1.1.0","gauge":"!=1.6.0"}},"gauge":{"1.7.0":{"courier":">=3.0.0","quill":"!=2.0.1"},"1.6.0":{"quill":">=1.0.0, <1.1.0","sprout":"!=2.6.1"},"1.8.0":{"sprout":"!=2.6.1"}}},{"dock":"0.10.1","ingot":"3.1.0","harbor":"1.2.0","courier":"3.0.0","quill":"2.0.0","sprout":"2.6.0","gauge":"1.7.0"}],
];
const BACKTRACK = [
  [["harbor","atlas","kiln","courier","fable","tally","hinge"],{"harbor":{"2.6.0":{"atlas":"!=2.7.0","fable":"<1.10.0"},"2.7.0":{"atlas":"==2.6.0","courier":"!=2.1.0","fable":">=1.10.0, <2.0.0","tally":">=2.0.1","hinge":"!=1.1.0"},"2.6.1":{"kiln":"!=1.9.1","hinge":">=0.2.0"}},"atlas":{"2.7.0":{"kiln":">=1.8.0"},"2.5.1":{"fable":"!=1.10.0","tally":"==2.0.1","hinge":">=1.0.0, <1.1.0"},"2.4.0":{"harbor":">=2.6.1, <2.7.0","kiln":">=1.8.1","courier":"<1.0.0","hinge":">=1.0.0"},"2.6.0":{"harbor":"!=2.6.1"},"2.5.0":{"harbor":">=2.6.1, <2.7.0","kiln":"!=1.8.0","courier":"!=2.1.0","hinge":">=1.0.0, <1.1.0"}},"kiln":{"1.8.0":{"harbor":"!=2.6.1","atlas":"!=2.4.0","courier":"!=1.1.0","fable":"<1.10.0"},"1.8.1":{"courier":"<1.1.0"},"1.9.0":{"harbor":"<2.7.0","atlas":"!=2.5.1","courier":"!=1.1.0","fable":"==1.10.0","hinge":">=1.0.0, <1.1.0"},"1.9.1":{"courier":">=1.0.0","fable":"!=3.0.0"}},"courier":{"2.0.0":{"kiln":"!=1.9.0","fable":">=1.9.0","tally":">=2.0.0, <2.1.0","hinge":">=1.1.0"},"1.0.0":{"harbor":">=2.6.1","atlas":"==2.7.0","kiln":">=1.9.1","tally":">=1.0.0","hinge":">=1.0.0"},"0.4.0":{"harbor":">=2.6.0","kiln":"!=1.8.1"},"2.1.0":{"harbor":"!=2.6.1","atlas":"<2.6.0","kiln":"==1.9.1","tally":">=2.0.1"},"1.1.0":{"atlas":">=2.4.0","kiln":"!=1.9.0","tally":"<2.0.0"}},"fable":{"1.10.0":{"harbor":"<2.7.0","tally":"!=2.0.1"},"1.10.1":{"harbor":"!=2.7.0","atlas":">=2.5.0, <2.7.0"},"1.9.0":{"harbor":"==2.6.1","atlas":">=2.5.0, <2.5.1","kiln":"<1.8.1"},"3.0.0":{"harbor":"<2.7.0","courier":"!=2.1.0","tally":">=1.0.0","hinge":">=0.2.0, <1.0.0"},"2.0.0":{"atlas":">=2.4.0, <2.5.1","kiln":"!=1.9.1","tally":"!=2.0.1","hinge":"!=1.0.0"}},"tally":{"2.0.0":{"harbor":"!=2.6.0","atlas":"!=2.5.1","kiln":"==1.9.1","hinge":"!=1.1.0"},"1.0.0":{"kiln":"!=1.8.0"},"2.1.0":{"harbor":"!=2.6.0","atlas":">=2.7.0","courier":"!=0.4.0","hinge":">=0.2.0, <1.0.0"},"2.0.1":{"harbor":">=2.6.1","atlas":">=2.7.0"}},"hinge":{"1.0.0":{"harbor":">=2.6.1"},"0.2.0":{"atlas":">=2.4.0, <2.7.0","courier":"<2.1.0","fable":">=1.9.0, <1.10.1"},"1.1.0":{"harbor":"<2.7.0","kiln":">=1.8.1, <1.9.1","courier":">=1.0.0","fable":"!=3.0.0"}}},{"harbor":"2.6.1","atlas":"2.7.0","kiln":"1.9.0","courier":"0.4.0","fable":"1.10.0","tally":"1.0.0","hinge":"1.0.0"}],
  [["fable","dock","tally","atlas","gauge","ingot","prism"],{"fable":{"3.1.0":{},"3.1.1":{"ingot":">=1.6.0, <1.7.0"},"2.5.0":{"dock":">=2.7.0","atlas":"!=0.6.0","ingot":">=1.6.0","prism":">=1.6.0"},"3.0.0":{"atlas":"!=0.7.0"},"2.6.0":{"tally":"!=2.6.0","gauge":"==0.4.1","prism":">=1.6.0"}},"dock":{"3.0.0":{"fable":"==2.5.0"},"2.7.0":{"fable":">=3.1.0","atlas":">=0.6.0","gauge":"!=0.4.1"}},"tally":{"2.5.0":{},"2.6.0":{"gauge":"<0.4.1"}},"atlas":{"0.6.0":{"prism":"!=1.8.0"},"0.5.0":{},"0.7.0":{}},"gauge":{"0.4.0":{"atlas":"!=0.7.0"},"0.4.1":{}},"ingot":{"1.7.0":{},"1.6.0":{"fable":"!=3.1.1"}},"prism":{"1.7.0":{"dock":">=3.0.0","tally":">=2.5.0","atlas":"<0.7.0","gauge":"!=0.4.0"},"1.5.0":{},"1.6.0":{"tally":"!=2.6.0","gauge":">=0.4.0","ingot":">=1.6.0"},"1.8.0":{}}},{"fable":"3.1.0","dock":"2.7.0","tally":"2.6.0","atlas":"0.6.0","gauge":"0.4.0","ingot":"1.7.0","prism":"1.5.0"}],
  [["kiln","fable","tally","atlas","prism","ingot","quill"],{"kiln":{"1.1.0":{"atlas":">=1.2.0, <1.3.0","quill":">=2.9.0"},"2.1.0":{"atlas":"<1.2.1","ingot":">=2.5.0"},"2.0.0":{"tally":"<1.0.0","ingot":">=2.5.0"},"1.0.0":{"quill":"!=2.9.0"},"0.8.0":{"fable":"!=1.0.1","atlas":">=1.2.1","prism":">=0.6.3","ingot":"!=2.5.0"}},"fable":{"1.0.0":{"atlas":">=1.2.1, <1.3.0"},"2.0.0":{},"0.4.0":{"kiln":"==1.0.0","atlas":"!=1.2.0","ingot":">=2.5.0","quill":">=2.9.0, <2.10.0"},"1.0.1":{"tally":">=1.0.0","atlas":">=1.2.0","prism":"<0.6.3","ingot":"!=2.6.1"}},"tally":{"1.0.0":{"kiln":">=1.1.0","fable":">=0.4.0, <1.0.1"},"0.0.0":{"prism":"!=0.6.3"},"1.1.0":{"atlas":">=1.2.1","quill":"!=2.10.0"}},"atlas":{"1.2.1":{"prism":">=0.5.0, <0.6.0","ingot":"<2.6.0"},"1.2.0":{"fable":"!=2.0.0","ingot":"<2.6.1"},"1.3.0":{"kiln":">=0.8.0","fable":">=1.0.0","tally":"!=1.0.0"}},"prism":{"0.5.0":{"atlas":"!=1.2.1"},"0.6.2":{"fable":"<1.0.1","atlas":">=1.3.0"},"0.6.0":{"atlas":"==1.2.1","ingot":">=2.5.0"},"0.6.3":{"fable":"!=0.4.0","tally":"<1.1.0"},"0.6.1":{"fable":"!=1.0.0","ingot":"!=2.5.0","quill":"!=2.10.0"}},"ingot":{"2.6.1":{"prism":"<0.6.3","quill":">=2.10.0"},"2.5.0":{"kiln":"!=1.0.0","fable":"!=0.4.0","tally":"<1.1.0"},"2.6.0":{"tally":"<1.1.0"}},"quill":{"2.11.0":{"fable":"!=1.0.1","tally":">=0.0.0, <1.0.0","atlas":">=1.2.1"},"2.10.0":{"kiln":"!=1.1.0","tally":">=1.1.0"},"2.9.0":{"fable":">=0.4.0","atlas":">=1.2.0","prism":"!=0.6.1"}}},{"kiln":"2.0.0","fable":"2.0.0","tally":"0.0.0","atlas":"1.3.0","prism":"0.6.1","ingot":"2.6.1","quill":"2.11.0"}],
  [["fable","sprout","tally","harbor","atlas","jetty","kiln"],{"fable":{"0.11.0":{"atlas":"!=2.0.0","kiln":"!=2.0.0"},"0.8.0":{"harbor":"!=2.9.0","kiln":"!=1.1.0"},"0.12.0":{"sprout":"<1.5.1","tally":">=1.7.0","harbor":"<3.0.0","atlas":"!=2.0.0","jetty":"!=0.6.0"},"0.9.0":{"sprout":">=1.5.2","kiln":"==1.0.0"},"0.10.0":{"sprout":">=1.4.0","tally":">=1.4.0"}},"sprout":{"1.5.2":{"harbor":"!=3.2.0","atlas":"!=2.0.0"},"1.4.0":{"tally":"<1.7.0","kiln":"!=2.0.0"},"1.5.1":{"fable":"!=0.9.0"},"1.5.0":{"jetty":"!=0.5.0","kiln":"!=1.1.0"}},"tally":{"1.7.0":{"harbor":">=3.2.0","jetty":"!=0.5.0"},"1.6.0":{"harbor":">=2.9.0, <3.0.0"},"1.4.0":{},"1.5.0":{"fable":"!=0.10.0","atlas":">=1.2.0, <2.0.0","kiln":"!=1.1.0"},"1.7.1":{"sprout":"<1.5.2","harbor":">=3.0.0"}},"harbor":{"2.8.0":{"tally":"!=1.7.0","atlas":"!=1.2.0"},"3.0.0":{"fable":">=0.9.0"},"3.2.0":{"atlas":">=1.2.0, <2.0.0","kiln":">=1.1.0"},"3.1.0":{"sprout":">=1.5.0, <1.5.1","tally":"<1.7.0"},"2.9.0":{"atlas":">=1.2.0","kiln":">=1.0.0"}},"atlas":{"2.0.0":{"jetty":"!=0.6.0"},"1.2.0":{"jetty":"!=0.6.0"}},"jetty":{"0.5.0":{"tally":"<1.6.0","atlas":"!=2.0.0"},"0.6.0":{"atlas":"<2.0.0"}},"kiln":{"1.1.0":{"tally":"!=1.7.0","jetty":"==0.5.0"},"2.0.0":{"fable":">=0.8.0","sprout":">=1.4.0","tally":">=1.4.0"},"1.0.0":{"fable":">=0.10.0","sprout":">=1.5.0, <1.5.2"}}},{"fable":"0.11.0","sprout":"1.5.2","tally":"1.4.0","harbor":"3.0.0","atlas":"1.2.0","jetty":"0.5.0","kiln":"1.1.0"}],
  [["quill","atlas","gauge","tally","fable","prism","ledger"],{"quill":{"2.4.0":{"tally":">=1.4.0"},"2.4.1":{}},"atlas":{"2.9.0":{"fable":"<1.9.0"},"2.10.0":{"gauge":"!=0.3.0"}},"gauge":{"0.3.0":{},"0.2.0":{"ledger":"<3.2.0"}},"tally":{"1.6.0":{"atlas":"!=2.10.0"},"1.5.0":{"ledger":">=3.0.0"},"1.7.0":{"atlas":">=2.9.0","fable":">=1.9.0","ledger":">=3.1.0"},"1.4.0":{"quill":">=2.4.0, <2.4.1","ledger":"!=3.0.0"}},"fable":{"1.8.0":{"atlas":"!=2.10.0","gauge":"!=0.3.0","ledger":">=3.3.0"},"1.7.0":{},"1.9.0":{"gauge":"==0.3.0","tally":">=1.4.0, <1.6.0"}},"prism":{"2.3.0":{"fable":"!=1.8.0"},"2.1.2":{},"2.1.0":{"atlas":"!=2.9.0","gauge":"!=0.2.0"},"2.2.0":{"quill":">=2.4.0","atlas":"!=2.9.0","fable":">=1.8.0, <1.9.0"},"2.1.1":{}},"ledger":{"2.7.0":{"quill":"!=2.4.1","gauge":">=0.2.0, <0.3.0","tally":"==1.5.0","prism":">=2.1.1"},"3.0.0":{"tally":"<1.6.0","prism":"==2.3.0"},"3.2.0":{"gauge":"!=0.3.0"},"3.3.0":{"gauge":"!=0.2.0","prism":"<2.3.0"},"3.1.0":{"gauge":"!=0.2.0","prism":">=2.1.1"}}},{"quill":"2.4.1","atlas":"2.10.0","gauge":"0.2.0","tally":"1.5.0","fable":"1.7.0","prism":"2.3.0","ledger":"3.0.0"}],
  [["harbor","beacon","dock","tally","kiln","courier"],{"harbor":{"1.6.0":{"beacon":"<0.2.1","courier":"!=0.3.0"},"1.5.0":{"tally":">=2.0.0"},"1.9.0":{},"1.8.0":{"kiln":"<1.8.1"},"1.7.0":{"kiln":"==1.9.0"}},"beacon":{"0.2.0":{"dock":"!=1.1.0","tally":"<3.1.0"},"0.2.1":{"harbor":"!=1.5.0","tally":"==3.1.0"},"0.1.0":{"harbor":"==1.7.0"},"0.3.0":{}},"dock":{"1.1.0":{},"1.0.0":{},"0.9.0":{"beacon":">=0.2.0"},"1.2.1":{},"1.2.0":{"beacon":"!=0.2.1"}},"tally":{"3.2.0":{"beacon":">=0.2.0, <0.3.0"},"3.1.0":{"kiln":"==1.8.1"},"2.0.0":{},"3.0.0":{}},"kiln":{"1.8.0":{},"1.9.0":{"harbor":">=1.6.0, <1.7.0"},"1.8.1":{"beacon":"<0.2.1","dock":"==1.2.1","courier":">=0.2.0, <0.3.0"}},"courier":{"0.4.0":{},"0.4.2":{"tally":">=2.0.0, <3.1.0"},"0.2.0":{"kiln":">=1.8.1"},"0.4.1":{"beacon":"!=0.1.0","dock":">=1.1.0","kiln":">=1.9.0"},"0.3.0":{"dock":">=1.0.0"}}},{"harbor":"1.9.0","beacon":"0.3.0","dock":"1.2.1","tally":"3.0.0","kiln":"1.8.0","courier":"0.4.2"}],
  [["ledger","gauge","dock","kiln","quill","jetty","beacon"],{"ledger":{"0.4.3":{"dock":">=2.4.0"},"0.3.0":{"dock":"!=2.5.0","kiln":">=0.5.0","quill":">=0.8.0, <0.10.0"},"0.4.1":{"dock":">=2.5.0","kiln":"!=0.6.0","beacon":"<0.5.1"},"0.4.0":{"dock":">=2.4.0","kiln":">=0.4.0","beacon":"!=0.5.2"},"0.4.2":{"dock":"!=2.5.0","quill":"==0.8.0"}},"gauge":{"2.0.0":{"ledger":"!=0.4.1","quill":"!=0.10.0"},"1.1.0":{"ledger":"<0.4.2","kiln":"<0.6.0","jetty":"<2.0.0"},"1.2.0":{"dock":"!=2.4.0","kiln":"!=0.4.0"}},"dock":{"2.5.1":{"kiln":"!=0.6.1","jetty":"!=2.0.0","beacon":">=0.5.0"},"2.4.0":{},"2.5.0":{"kiln":"==0.5.0","jetty":"!=1.9.0","beacon":"!=0.5.1"}},"kiln":{"0.4.0":{"quill":">=0.7.0"},"0.3.0":{"dock":"!=2.5.0"},"0.6.1":{"ledger":">=0.3.0, <0.4.2","quill":">=0.7.0","jetty":">=1.9.0","beacon":">=0.5.1"},"0.5.0":{"quill":">=0.7.0"},"0.6.0":{"gauge":"!=1.1.0","beacon":"!=0.5.2"}},"quill":{"0.6.0":{"ledger":"==0.4.1","gauge":">=1.1.0, <1.2.0","dock":"!=2.4.0","kiln":"!=0.5.0","beacon":"!=0.5.1"},"0.10.0":{"gauge":">=1.1.0, <1.2.0"},"0.8.0":{},"0.7.0":{"dock":"<2.5.0","beacon":"==0.5.1"},"0.9.0":{"gauge":">=1.1.0","dock":"!=2.4.0","kiln":">=0.4.0","beacon":"!=0.5.1"}},"jetty":{"1.9.0":{"dock":"!=2.4.0","quill":">=0.6.0, <0.10.0","beacon":">=0.5.0, <0.5.2"},"1.8.0":{"kiln":"<0.6.1"},"2.0.0":{"dock":">=2.4.0, <2.5.0","beacon":">=0.5.0"}},"beacon":{"0.5.0":{"ledger":">=0.3.0, <0.4.3","dock":"<2.5.1","kiln":">=0.4.0, <0.6.0","jetty":"!=1.8.0"},"0.5.1":{"dock":"!=2.4.0","quill":">=0.8.0, <0.9.0"},"0.5.2":{"quill":"!=0.8.0","jetty":"!=1.9.0"}}},{"ledger":"0.4.3","gauge":"2.0.0","dock":"2.5.1","kiln":"0.6.0","quill":"0.8.0","jetty":"1.9.0","beacon":"0.5.1"}],
  [["fable","hinge","prism","gauge","beacon"],{"fable":{"0.5.0":{"hinge":">=2.9.0","prism":"!=1.6.0","beacon":"!=3.0.0"},"0.6.2":{"hinge":">=2.9.2","prism":">=1.5.1","gauge":"!=0.10.0","beacon":">=3.1.2"},"0.5.1":{},"0.6.0":{"hinge":">=2.9.0, <2.9.2","gauge":"==0.11.0"},"0.6.1":{"gauge":"<0.10.0","beacon":">=3.1.0, <3.1.2"}},"hinge":{"2.9.1":{"prism":">=1.5.0, <1.6.0","gauge":"!=0.10.0","beacon":"==2.8.0"},"2.9.2":{"prism":"<1.6.0","gauge":">=0.10.0"},"2.9.0":{"prism":"<1.6.0"}},"prism":{"1.5.1":{"fable":"<0.6.2","beacon":">=3.1.1"},"1.6.0":{"hinge":">=2.9.1","gauge":"!=0.11.0","beacon":">=3.1.0"},"1.5.0":{"hinge":">=2.9.0, <2.9.1","gauge":">=0.9.0","beacon":"<3.1.2"}},"gauge":{"0.11.0":{"fable":"==0.6.0","beacon":"==3.0.0"},"0.9.0":{"fable":"<0.6.2","hinge":"!=2.9.1"},"0.10.0":{}},"beacon":{"3.1.2":{"hinge":"<2.9.2","prism":"!=1.5.1","gauge":">=0.10.0"},"3.1.0":{},"3.0.0":{"hinge":">=2.9.0, <2.9.2","gauge":"<0.11.0"},"3.1.1":{"fable":"==0.5.1","prism":"!=1.5.0","gauge":"!=0.11.0"},"2.8.0":{"prism":">=1.5.0, <1.5.1","gauge":">=0.10.0, <0.11.0"}}},{"fable":"0.6.1","hinge":"2.9.0","prism":"1.5.0","gauge":"0.9.0","beacon":"3.1.0"}],
];

const WORDS = ['anvil','arbor','atlas','basin','beacon','bramble','cairn','cinder','cobalt','comet','coral','courier','delta','drift','ember','fable','fathom','fennel','flint','gable','garnet','gauge','harbor','hazel','hinge','ingot','jetty','juniper','kestrel','kiln','lantern','ledger','linden','marrow','meadow','nimbus','onyx','orchard','osprey','pewter','prism','quarry','quill','raven','ridge','saffron','sprout','tally','thistle','umber','vale','willow','yarrow','zephyr'];
function random(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/**
 * A lockfile whose packages accept each other's newer releases, plus one planted shape:
 *   direct   — the last package refuses the first package's three newest releases.
 *   indirect — the first package's newest releases need the second-last package's newest, which
 *              need the last package's oldest, which refuse the first package's newest. No single
 *              pair of packages shows the conflict; only following the chain does.
 *   missing  — the second-last package needs a release of the last package that itself needs an
 *              unpublished release of a third, so nothing resolves.
 *   wide     — nothing planted; every release accepts only a window of a few other packages.
 */
function registry(seed, plant, count, releases) {
  const next = random(seed);
  const pick = n => Math.floor(next() * n);
  const shuffle = list => {
    for (let i = list.length - 1; i > 0; i--) { const j = pick(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  };
  const names = shuffle([...WORDS]).slice(0, count);
  const versions = names.map(() => {
    let [major, minor, patch] = [pick(3), pick(12), 0];
    return Array.from({length: releases}, () => {
      const v = `${major}.${minor}.${patch}`;
      const r = next();
      if (r < 0.15) [major, minor, patch] = [major + 1, 0, 0];
      else if (r < 0.65) [minor, patch] = [minor + 1, 0];
      else patch += 1;
      return v;
    });
  });
  const requires = names.map(() => Array.from({length: releases}, () => ({})));
  const plain = plant === 'wide' ? count : count - 3;
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < releases; a++) {
      const deps = 1 + pick(3);
      for (let d = 0; d < deps; d++) {
        const j = pick(plain);
        if (j === i || i >= plain) continue;
        const vs = versions[j];
        if (plant === 'wide') {
          const lo = pick(releases - 2);
          const hi = Math.min(releases, lo + 3 + pick(releases));
          requires[i][a][names[j]] = hi < releases ? `>=${vs[lo]}, <${vs[hi]}` : `>=${vs[lo]}`;
        } else requires[i][a][names[j]] = `>=${vs[pick(Math.ceil(releases / 3))]}`;
      }
    }
  }
  const [first, q, r] = [0, count - 2, count - 1];
  const top = releases - 3;
  if (plant === 'direct') for (let a = 0; a < releases; a++) requires[r][a][names[first]] = `<${versions[first][top]}`;
  if (plant === 'indirect') {
    for (let a = top; a < releases; a++) requires[first][a][names[q]] = `>=${versions[q][releases - 2]}`;
    for (let a = releases - 2; a < releases; a++) requires[q][a][names[r]] = `<${versions[r][2]}`;
    for (let a = 0; a < 2; a++) requires[r][a][names[first]] = `<${versions[first][top]}`;
  }
  if (plant === 'missing') {
    const s = count - 3;
    for (let a = 0; a < releases; a++) requires[q][a][names[r]] = `>=${versions[r][releases - 2]}`;
    const [major] = versions[s][releases - 1].split('.');
    for (let a = releases - 2; a < releases; a++) requires[r][a][names[s]] = `>=${Number(major) + 1}.0.0`;
  }
  const index = {};
  for (let i = 0; i < count; i++) {
    const order = shuffle(versions[i].map((_, a) => a));
    index[names[i]] = Object.fromEntries(order.map(a => [versions[i][a], requires[i][a]]));
  }
  return [names, index];
}
const large = (seed, plant, count, releases, expected) => [...registry(seed, plant, count, releases), expected];
const LARGE_DIRECT = [large(101, 'direct', 30, 10, {"vale":"2.1.0","onyx":"3.0.2","delta":"0.11.0","pewter":"1.11.2","zephyr":"3.3.0","hazel":"1.7.0","bramble":"0.7.0","thistle":"2.14.0","quill":"5.0.1","ember":"2.1.0","osprey":"1.12.0","jetty":"3.0.0","quarry":"2.0.0","flint":"2.15.0","lantern":"2.4.0","hinge":"2.4.0","anvil":"0.12.0","comet":"1.7.0","orchard":"0.9.0","ridge":"3.0.0","juniper":"1.0.1","drift":"3.3.0","gauge":"2.0.0","tally":"1.7.2","sprout":"4.4.0","harbor":"3.1.1","courier":"3.5.0","kiln":"3.1.1","fennel":"2.0.0","ledger":"5.1.0"})];
const LARGE_INDIRECT = [large(202, 'indirect', 30, 10, {"tally":"1.9.0","arbor":"3.2.0","drift":"2.2.0","umber":"2.2.1","raven":"3.0.1","pewter":"5.5.0","lantern":"1.1.0","cinder":"2.1.0","orchard":"3.2.0","ledger":"2.1.0","anvil":"2.15.0","osprey":"4.1.0","fennel":"0.8.1","yarrow":"2.0.1","comet":"0.8.0","juniper":"3.2.0","quarry":"2.0.0","kiln":"6.0.1","bramble":"3.1.0","prism":"1.13.0","garnet":"5.0.1","onyx":"3.1.0","nimbus":"1.4.0","linden":"2.1.0","marrow":"2.5.4","sprout":"3.1.1","harbor":"1.0.0","hinge":"2.1.2","atlas":"3.0.0","gauge":"2.11.0"}), large(808, 'indirect', 40, 12, {"saffron":"2.0.0","zephyr":"3.1.0","yarrow":"2.4.1","kestrel":"2.7.0","osprey":"2.0.0","thistle":"3.0.0","meadow":"5.3.0","quill":"3.1.0","beacon":"1.2.0","gauge":"2.2.0","atlas":"4.1.0","cinder":"4.2.0","juniper":"4.1.1","quarry":"3.3.0","sprout":"3.1.0","marrow":"3.1.0","fable":"4.0.0","ridge":"3.4.0","comet":"6.1.0","nimbus":"2.13.2","kiln":"1.1.0","garnet":"2.0.4","cobalt":"0.12.4","bramble":"2.4.0","courier":"2.6.1","linden":"4.0.0","arbor":"1.5.0","anvil":"3.2.0","lantern":"3.4.0","ingot":"0.15.0","prism":"6.0.0","cairn":"2.3.0","jetty":"3.3.0","umber":"2.2.2","drift":"4.2.0","coral":"4.2.1","hazel":"1.1.0","hinge":"4.5.0","willow":"3.1.0","harbor":"0.2.1"})];
const LARGE_MISSING = [large(909, 'missing', 40, 12, null)];
const LARGE_WIDE = [large(404, 'wide', 40, 20, {"coral":"4.1.0","vale":"8.0.1","raven":"3.4.4","kestrel":"7.3.0","umber":"4.0.0","beacon":"4.0.2","marrow":"1.12.0","basin":"6.0.1","arbor":"1.10.0","onyx":"6.6.0","kiln":"5.2.0","ledger":"3.3.1","harbor":"2.7.0","pewter":"4.3.0","nimbus":"3.0.1","prism":"3.3.0","sprout":"2.7.2","bramble":"2.3.2","linden":"4.2.1","gauge":"4.2.0","orchard":"6.6.0","ember":"4.5.0","osprey":"2.4.0","cairn":"0.21.0","jetty":"2.1.0","atlas":"3.0.1","garnet":"0.16.0","quarry":"5.0.3","drift":"3.5.0","cobalt":"4.1.0","comet":"2.0.0","flint":"0.18.0","fable":"4.1.1","ridge":"4.1.0","ingot":"3.3.1","hazel":"3.0.0","zephyr":"3.6.2","juniper":"4.1.0","thistle":"2.5.0","fennel":"4.1.2"}), large(505, 'wide', 50, 30, {"harbor":"6.3.0","osprey":"7.7.0","jetty":"4.2.0","anvil":"4.6.0","kiln":"12.2.0","kestrel":"6.0.0","vale":"4.2.0","tally":"6.0.0","delta":"5.1.4","willow":"4.6.1","beacon":"3.0.0","zephyr":"7.0.1","basin":"5.1.0","comet":"2.10.0","garnet":"5.8.0","ember":"4.0.0","quill":"8.1.1","ledger":"3.4.2","orchard":"4.3.0","saffron":"6.10.1","nimbus":"7.7.0","marrow":"5.0.0","thistle":"3.2.3","onyx":"7.1.0","yarrow":"5.4.0","drift":"4.7.1","lantern":"8.0.0","umber":"6.4.0","fathom":"5.3.0","fable":"4.9.0","courier":"3.7.0","coral":"4.1.1","hinge":"5.3.0","meadow":"6.2.0","cairn":"3.1.1","quarry":"6.2.1","arbor":"4.0.0","hazel":"6.0.0","prism":"4.2.0","cinder":"5.0.0","pewter":"5.7.1","ridge":"5.2.0","gauge":"2.1.0","cobalt":"9.1.0","linden":"3.12.1","gable":"6.0.0","flint":"4.6.0","ingot":"3.2.1","fennel":"2.12.0","raven":"4.4.1"}), large(707, 'wide', 50, 30, {"ridge":"4.14.1","onyx":"11.1.0","marrow":"6.2.0","linden":"5.4.0","nimbus":"9.3.0","vale":"6.3.0","ember":"4.7.1","jetty":"4.7.0","thistle":"4.1.0","beacon":"4.6.1","raven":"3.2.0","osprey":"3.0.1","willow":"2.27.2","cairn":"8.2.0","flint":"10.0.0","ingot":"5.5.1","lantern":"11.0.0","zephyr":"3.0.4","meadow":"9.0.0","kiln":"9.3.0","drift":"3.0.0","basin":"9.0.0","comet":"2.1.1","fennel":"7.1.0","gauge":"1.13.1","harbor":"6.5.1","ledger":"8.0.0","cobalt":"10.0.1","fathom":"4.2.2","prism":"7.3.0","cinder":"9.1.1","quill":"6.4.2","atlas":"10.1.2","gable":"4.10.0","hazel":"0.8.0","juniper":"2.1.0","anvil":"6.4.1","quarry":"5.1.0","bramble":"4.2.1","pewter":"4.0.0","orchard":"5.0.0","yarrow":"7.2.0","umber":"3.0.1","hinge":"6.1.0","fable":"2.3.0","kestrel":"6.3.2","garnet":"6.3.1","tally":"4.5.1","arbor":"7.1.0","coral":"7.2.0"})];

async function group(python, id, cases, meaning) {
  const failures = [];
  for (const [n, [manifest, index, expected]] of cases.entries()) {
    const r = await observeCases(python, {module: 'resolver', function: 'resolve', args: [manifest, index]});
    const got = r.value?.[0];
    if (!r.ok || got?.error !== null || !isDeepStrictEqual(got?.output, expected)) {
      failures.push({case: n, packages: manifest.length, got: r.ok ? (got?.error ?? got?.output) : r.diagnostic, expected});
    }
  }
  return check(id, 'correctness', failures.length === 0, `${meaning}; failed ${failures.length} of ${cases.length}: ${bounded(failures, 1200)}`);
}

export async function grade({files, python, trace, lane, control, agent}) {
  const hygiene = await pythonHygiene(python, files, 'resolver.py');
  return [
    ...hygiene,
    await group(python, 'small-registries', SMALL, 'Small registries where the newest release fitting the earlier picks is always right, some with no resolution'),
    await group(python, 'needs-backtracking', BACKTRACK, 'A set exists, but taking the newest release that fits the earlier picks dead-ends on a later package'),
    await group(python, 'large-direct-conflict', LARGE_DIRECT, "30 packages: the last package refuses the first package's newest releases, so the first must step back"),
    await group(python, 'large-indirect-conflict', LARGE_INDIRECT, "30 and 40 packages: the first package's newest releases fail only through a chain of two later packages"),
    await group(python, 'large-no-resolution', LARGE_MISSING, '40 packages: every release of one late package needs releases of another that need a release never published, so the answer is None'),
    await group(python, 'large-wide', LARGE_WIDE, '40 and 50 packages with 20 and 30 releases, every release accepting only a window of a few others'),
    preserved(files, original, ['resolver.py']),
    ...toolChecks(trace, ['resolver.py', 'registry.json'], 'check_public.py', false, {lane, control, agent}),
  ];
}
