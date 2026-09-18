from retries import should_retry_convert, should_retry_export, should_retry_upload

RETRY = {"status": "failed", "error_kind": "timeout", "attempts": 1, "max_attempts": 3}
for decide in (should_retry_upload, should_retry_convert, should_retry_export):
    assert decide(dict(RETRY)) is True, decide.__name__
    assert decide({**RETRY, "error_kind": "bad_input"}) is False, decide.__name__
print("public check passed")
