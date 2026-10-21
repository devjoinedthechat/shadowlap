# @shadowlap/remote

Push, pull and share [Shadowlap](https://github.com/devjoinedthechat/shadowlap) runs through a bucket you own: Amazon S3, Cloudflare R2 and other S3-compatible stores, Google Cloud Storage or Azure Blob Storage.

It comes with the [`shadowlap` CLI](https://www.npmjs.com/package/shadowlap):

```sh
npm install -g shadowlap
shadowlap store set s3://northwind-agent-runs/support-agent --check
shadowlap push --all
shadowlap pull
shadowlap share <run>
```

`store set --check` connects your bucket once this machine's access works, `push --all` sends every run on this machine, `pull` brings your teammates' runs, and `share` writes a redacted report behind a link that works for 7 days.

Each machine reaches the bucket with its own credentials, from the environment or where each cloud's CLI keeps them: no cloud SDK is bundled, nothing passes through Shadowlap, and there are no accounts. A blob many runs share goes up once, labels and notes merge both ways, and a pull request's CI job writes only to its own folder.

[Sharing runs](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/team.md) covers access, CI and share links.
