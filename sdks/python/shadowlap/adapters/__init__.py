"""Framework adapters: declare a tool's effect once, in the way each framework defines tools.

- `shadowlap.adapters.openai_agents.function_tool`: the OpenAI Agents SDK's `function_tool`, with an effect.
- `shadowlap.adapters.langchain.with_effect`: a LangChain or LangGraph tool instance.
- `shadowlap.adapters.crewai.with_effect`: a CrewAI tool instance.

Pydantic AI needs no adapter: put `@tool(effect=...)` under `@agent.tool`. The adapters import
nothing from the frameworks at module level except where the framework is the point of the module,
and never change a tool outside `shadowlap run`: without SHADOWLAP_URL every call passes through.
"""
