# @shadowlap/remote

Shadowlap's team run store, in a bucket you own: Amazon S3, Cloudflare R2 and other S3-compatible
stores, Google Cloud Storage and Azure Blob Storage. It pushes runs from a project's
`.shadowlap/` store to the bucket and pulls teammates' runs back, content-addressed so a blob shared
by many runs goes up once, and merges labels and notes both ways. It also writes the redacted
reports behind share links, checks a bucket's access, encryption, versioning and object lock, and
prints the access policies and CI step to ask for. A pull request's CI job writes only to that pull
request's own folder in the store, which a pull leaves out unless asked.

Requests go straight to the cloud with your own credentials, found where each cloud's CLI keeps
them; no cloud SDK is bundled and nothing passes through Shadowlap. Free and open source under
Apache-2.0, like the rest of Shadowlap.

Used by the `shadowlap` CLI (`push`, `pull`, `share`, `store`) and the dashboard; you rarely need
it directly.

Docs: https://github.com/devjoinedthechat/shadowlap
