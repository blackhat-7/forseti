"""Choose which maintenance jobs each field crew takes this week."""
import bisect


def best_single_crew(jobs, gap):
    """Most valuable set of jobs one crew can do back to back, as a list of jobs."""
    jobs = sorted(jobs, key=lambda job: job["end"])
    ends = [job["end"] for job in jobs]
    best = [0] * (len(jobs) + 1)
    take = [False] * len(jobs)
    for i, job in enumerate(jobs):
        # Jobs a crew could have finished, plus travel, before this one starts.
        before = bisect.bisect_right(ends, job["start"] - gap, 0, i)
        with_job = best[before] + job["value"]
        take[i] = with_job > best[i]
        best[i + 1] = max(best[i], with_job)
    chosen = []
    i = len(jobs)
    while i > 0:
        if take[i - 1]:
            job = jobs[i - 1]
            chosen.append(job)
            i = bisect.bisect_right(ends, job["start"] - gap, 0, i - 1)
        else:
            i -= 1
    return chosen[::-1]


def assign_crews(jobs, crews, gap):
    left = list(jobs)
    plan = []
    for _ in range(crews):
        chosen = best_single_crew(left, gap)
        plan.append([job["id"] for job in chosen])
        taken = {job["id"] for job in chosen}
        left = [job for job in left if job["id"] not in taken]
    return plan
