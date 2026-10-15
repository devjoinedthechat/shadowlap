# A chat agent that waits for a person

A support agent for a kitchen appliance shop. It asks the customer what's wrong with `input()`, looks
the order up, asks whether they want a refund or a replacement, does what they answered, and waits for
the next message. The model is the repository's mock of the Anthropic API, so nothing here needs an
API key or a model server.

An agent like this is hard to replay: it stops and waits for someone to type. Shadowlap records what
the customer typed as `user_input` calls, so the chat replays, forks, tests and blames with no one at
the keyboard.

## Setup

You need Python 3.9 or later, Node 22.13 or later, and this repository built (`npm install && npm run
build` at the root).

```sh
cd examples/support-chat
pip install -e ../../sdks/python               # the agent's tools use the Shadowlap SDK
alias shadowlap="node $PWD/../../packages/cli/bin/shadowlap.js"
node mock_model.mjs &                           # prints the mock's address
export SHADOWLAP_UPSTREAM_ANTHROPIC=http://127.0.0.1:<port>
```

## Record

```sh
shadowlap run -- python support_chat.py
```

```
How can I help? My blender arrived broken. Order A-1042.
  (lookup_order {"order_id": "A-1042", "item": "blender", "amount": 240, "status": "delivered"})
I'm sorry it arrived broken. Would you like a refund or a replacement?
> A replacement, please.
  (create_replacement {"ok": true, "shipment": "S-5531"})
Done: a replacement ships today as S-5531. Anything else?
> No, thanks!
Glad I could help. Have a good day.
>

● Recorded 01K5CQ9C4H…: 11 calls (5 api, 6 tool), 5 upstream requests
```

`shadowlap show <run>` lists each answer as a call: `user_input`, a read, with the prompt as its
argument and what was typed as its result. The empty answer at the end, or Ctrl-D, is recorded too:
it is where the chat ended.

```
  #1   tool  user_input          live  ok     {"prompt":"How can I help? "}
  #2   api   POST /v1/messages   live  ok     tool_use
  #3   tool  lookup_order        live  ok     {"order_id":"A-1042"}
  #4   api   POST /v1/messages   live  ok     end_turn
  #5   tool  user_input          live  ok     {"prompt":"> "}
  …
```

## Replay with no one typing

```sh
shadowlap replay <run> < /dev/null
```

```
✓ Replay clean: 11/11 calls replayed (5 api, 6 tool), 0 upstream requests
```

Every answer came from the recording, so the chat ran to the end without anyone at the keyboard. In
a terminal, a replay shows each answer after its prompt, as if it were typed.

## Answer differently as the user

What if the customer had wanted a refund? Give call #5 another answer:

```sh
echo '{"text": "A refund, please."}' > reply.json
shadowlap replay <run> --override 5=@reply.json
```

```
⑂ Forked at call 6: 5 calls replayed (1 overridden), then 3 live, 1 write blocked
  ~ $.messages[4].content
      - "A replacement, please."
      + "A refund, please."
```

The model sees the new answer at call 6, so the run forks there and goes on live. `issue_refund` is a
write, so after the fork it is blocked (or stubbed, with `--writes stub`), and no refund is issued.
After the fork there is still no one to type, so the customer's later answers come from the recording
in the order they were given: "No, thanks!" ends the chat. To type them yourself instead, add
`--live-input`.

## Keep it as a test

```sh
shadowlap pack <run> goldens/chat
shadowlap test goldens/chat
```

`shadowlap test` starts the agent with its input ignored, as CI does, and the recorded answers carry
the chat through. `blame` and `verify` run it the same way.
