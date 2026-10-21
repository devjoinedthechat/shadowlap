# @shadowlap/dashboard

The local web UI behind `shadowlap dashboard`: your agent's runs, forks, fixes and tests in a browser, on 127.0.0.1.

It comes with the [`shadowlap` CLI](https://www.npmjs.com/package/shadowlap):

```sh
npm install -g shadowlap
shadowlap dashboard                   # opens http://127.0.0.1:4777/#token=…
shadowlap dashboard <run> --call 5    # opens a run at a call
```

Step through a run call by call and read the conversation exactly as the model saw it. Fork from any call, compare two runs side by side, follow a fix from the call blame named to verify's verdict, and see how each golden did at each revision. Its pages are Overview, Runs, Compare, Fixes, Tests, Training and Settings, and ⌘K or Ctrl K jumps to any page, run or action. One dashboard serves every project on the machine.

Recordings hold prompts and tool data, so it stays local: it answers only requests addressed to localhost, serves data only with the session token in the link it prints, and loads nothing from the network. `shadowlap export html <run>` writes the same views into one file, to attach to a pull request.

[Dashboard](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/dashboard.md) walks through every page and action.
