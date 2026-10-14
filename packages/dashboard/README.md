# @shadowlap/dashboard

The local web dashboard behind `shadowlap dashboard`, and the single-file export behind `shadowlap export html`: your recordings in a browser. Runs and their forks, a timeline of every call colored by what happened to it, the conversation exactly as the model saw it at any call, streamed responses played back at their recorded pacing, fork diffs, cross-run comparison, and replay and fork actions that run the CLI.

It binds to 127.0.0.1, answers only requests addressed to localhost, and serves data only with the session token in the link it prints. The page loads nothing from the network.

Docs: https://github.com/devjoinedthechat/shadowlap/blob/main/docs/dashboard.md
