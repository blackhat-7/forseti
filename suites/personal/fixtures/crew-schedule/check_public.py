import json
from pathlib import Path

from crews import assign_crews

week = json.loads(Path("jobs.json").read_text())
jobs, gap = week["jobs"], week["travel_minutes"]
by_id = {job["id"]: job for job in jobs}

for crews, best in ((week["crews"], 51), (3, 56)):
    plan = assign_crews(jobs, crews, gap)
    assert len(plan) == crews, plan
    ids = [job_id for crew in plan for job_id in crew]
    assert len(ids) == len(set(ids)) and set(ids) <= set(by_id), plan
    for crew in plan:
        done = sorted((by_id[job_id] for job_id in crew), key=lambda job: job["start"])
        for before, after in zip(done, done[1:]):
            assert after["start"] >= before["end"] + gap, (before["id"], after["id"])
    total = sum(by_id[job_id]["value"] for job_id in ids)
    assert total == best, (crews, total, plan)
print("public check passed")
