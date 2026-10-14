"""One tau2-bench task, run so that Shadowlap can record, replay and fork it.

    python run_task.py --domain retail --split test --task 5 \\
        --agent-llm openai/gpt-5-mini --user-llm openai/gpt-4.1

It exits 0 when the task earns the full reward and 1 when it doesn't, so the agent's exit code is the
oracle `shadowlap blame`, `verify` and `repair` judge by. Everything that makes the run this run is an
argument, because a replay re-runs the recorded command in today's environment.

The agent's model calls are made in scope "agent" and the simulated user's in scope "user", so blame
can probe the agent without ever blaming the customer. The policy the agent is given is read from
TAU2_DATA_DIR, which the harness points at the project's own copy, where repair can edit it.
"""

import argparse
import json
import sys

from shadowlap import scope


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--domain", default="retail")
    p.add_argument("--split", default="test")
    p.add_argument("--task", required=True)
    p.add_argument("--agent-llm", required=True, help="a litellm model, such as openai/gpt-5-mini")
    p.add_argument("--user-llm", required=True, help="the model that plays the customer")
    p.add_argument("--api-base", help="an OpenAI-compatible server for both models, such as Ollama")
    p.add_argument("--agent-temperature", type=float, default=0.0)
    p.add_argument("--user-temperature", type=float, default=0.0)
    p.add_argument("--seed", type=int, default=300)
    p.add_argument("--max-steps", type=int, default=60)
    p.add_argument("--max-tokens", type=int, default=4096, help="per model call; a thinking model left unbounded can loop until the run is killed")
    a = p.parse_args()

    from tau2.agent.llm_agent import LLMAgent
    from tau2.user.user_simulator import UserSimulator

    # Whose model call is whose: the agent's are what blame probes and repair fixes.
    for cls, name in ((LLMAgent, "agent"), (UserSimulator, "user")):
        original = cls.generate_next_message

        def generate_next_message(self, *args, _original=original, _name=name, **kwargs):
            with scope(_name):
                return _original(self, *args, **kwargs)

        cls.generate_next_message = generate_next_message

    from tau2.data_model.simulation import TextRunConfig
    from tau2.run import get_tasks, run_single_task

    def llm_args(temperature: float) -> dict:
        return {"temperature": temperature, "max_tokens": a.max_tokens, **({"api_base": a.api_base} if a.api_base else {})}

    config = TextRunConfig(
        domain=a.domain,
        agent="llm_agent",
        llm_agent=a.agent_llm,
        llm_args_agent=llm_args(a.agent_temperature),
        user="user_simulator",
        llm_user=a.user_llm,
        llm_args_user=llm_args(a.user_temperature),
        max_steps=a.max_steps,
        seed=a.seed,
    )
    task = get_tasks(a.domain, task_split_name=a.split, task_ids=[a.task])[0]
    run = run_single_task(config, task, seed=a.seed)
    reward = run.reward_info.reward if run.reward_info else 0.0
    print(json.dumps({"task": a.task, "reward": reward, "termination": str(run.termination_reason), "messages": len(run.messages)}))
    return 0 if reward >= 1.0 - 1e-6 else 1


if __name__ == "__main__":
    sys.exit(main())
