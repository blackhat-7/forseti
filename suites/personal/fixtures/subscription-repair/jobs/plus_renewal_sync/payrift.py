"""Minimal Payrift API client used by the billing jobs."""
import httpx

API = "https://api.payrift.com/v1"


class Client:
    def __init__(self, api_key, timeout=10.0):
        self._http = httpx.Client(
            base_url=API,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=timeout,
        )

    def cancel_subscription(self, subscription_id, reason):
        response = self._http.post(f"/subscriptions/{subscription_id}/cancel",
                                   json={"cancellation_reason": reason})
        response.raise_for_status()
        return response.json()
