# @shadowlap/tui

The terminal UI behind `shadowlap ui`: where a run forked, what each call sent and got back, and a fork from the call in front of you, without leaving the terminal.

It comes with the [`shadowlap` CLI](https://www.npmjs.com/package/shadowlap):

```sh
npm install -g shadowlap
shadowlap ui                    # the run tree
shadowlap ui <run> --call 5     # a run's timeline, at a call
```

The selected call shows in an inspector with conversation, request, response and meta tabs. `space` plays a streamed response at its recorded pacing, `d` shows the divergence diff, `/` searches, `:` lists the what-ifs for the selected call, and `o` opens it in the dashboard.

[Terminal UI](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/tui.md) lists every key.
