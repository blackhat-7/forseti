# Uploads pipeline

Owner: media team (#media-eng). Pager: media-oncall.

## How an upload flows

1. The app asks `uploads-api` (namespace `media`, prod cluster) for an upload. `uploads-api`
   writes the original to the bucket named by `UPLOAD_BUCKET` in the `uploads-config` ConfigMap,
   as the `uploads-api` service account (Workload Identity).
2. The bucket sends an `OBJECT_FINALIZE` notification to the `uploads-thumbnailer` topic.
   `thumbnailer` reads the original (as the `thumbnailer` service account) and writes
   thumbnails to `qm-user-thumbs`.
3. Clients load originals from `https://cdn.quillmart.com/<object name>`. That hostname is a
   Cloud CDN backend bucket, `uploads-cdn-backend`, which reads the bucket as the project's CDN
   fill service account.

Object names are `u/YYYY/MM/DD/<id>.<ext>`. The app stores the object name, never the bucket, so
moving objects between buckets is invisible to clients as long as names are kept.

## Traffic

About 40 uploads a minute during the European day, a little more at weekends. The bucket holds
roughly 1.8 million originals, 2.3 TiB.

## Health checks

- Upload errors: `kubectl -n media logs deploy/uploads-api --tail=50`
- Thumbnails: `kubectl -n media logs deploy/thumbnailer --tail=50`
- CDN: `curl -sI https://cdn.quillmart.com/<object name>`

## Changing the upload bucket

`UPLOAD_BUCKET` is read once at startup. Pods only pick up a ConfigMap change when they are
recreated.
