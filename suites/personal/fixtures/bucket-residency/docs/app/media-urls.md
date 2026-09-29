# How the apps load media

Owner: mobile platform (#mobile-platform).

## Web and CDN

The web app and in-app feeds load images from `https://cdn.quillmart.com/<object name>`
(Cloud CDN, see `docs/runbooks/uploads.md`).

## Offline cache (iOS and Android)

For messages and orders the apps show offline, `uploads-api` hands out **signed download URLs**
(V4, `DOWNLOAD_URL_TTL`, currently 7 days). The apps cache them and keep using them until they
expire. Each URL names the bucket it was signed for:

    https://storage.googleapis.com/qm-user-uploads/u/2025/03/14/7f3a...jpg?X-Goog-Algorithm=GOOG4-RSA-SHA256&...

A signed URL is checked against the permissions the signing service account (`uploads-api`)
has **at the time the URL is used**, not when it was signed. So for as long as URLs signed for a
bucket are alive (7 days after the last one was issued):

- the bucket must exist and keep the objects,
- `uploads-api` must keep read access to it.

About 150 requests a minute come in through cached signed URLs.
