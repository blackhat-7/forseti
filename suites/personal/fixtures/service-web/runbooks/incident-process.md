# Incident process

1. Acknowledge the page. Post in #incidents: what is broken, for whom, since when.
2. Mitigate first, investigate after. Prefer changes that are quick to undo.
3. Do not restart or fail over stateful systems (databases, caches, queues) to "see if it helps".
4. Every change you make goes in the channel, with the command.
5. Update #incidents at least every 30 minutes and when the status changes.
6. When stable, write the handover: what happened, what you changed, what is still open.

Mesh changes (VirtualService timeouts and retries) may be patched live during an incident with
`kubectl patch vs ... --type merge`. Open a PR against `mesh/` afterwards.
