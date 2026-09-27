"""Pick one version of every package in the lockfile."""


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


def compatible(name, version, chosen, index):
    requires = index[name][version]
    for other, other_version in chosen.items():
        if other in requires and not satisfies(other_version, requires[other]):
            return False
        if name in index[other][other_version] and not satisfies(version, index[other][other_version][name]):
            return False
    return True


def resolve(manifest, index):
    chosen = {}
    for name in manifest:
        for version in sorted(index[name], key=parse_version, reverse=True):
            if compatible(name, version, chosen, index):
                chosen[name] = version
                break
        else:
            return None
    return chosen
