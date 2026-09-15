"""
Who answers when the data layer needs a model.

There are exactly two places that call one - question -> SQL
(`app.query.llm`) and the dashboard agent (`app.agent.model`) - and both of
them ask `app.llm.provider` rather than a vendor. That is the whole point of
this package: the guard, the tools, the loop, the events and the endpoints are
written against our own shapes, so swapping the model behind them is a
configuration change (`ODL_LLM_PROVIDER`) and not a change to any of them.

  * `config`    the settings, and the defaults that follow from the choice
  * `provider`  the three functions a provider has to offer, and the choosing
  * `anthropic` the hosted path, as it has always been
  * `ollama`    a model on the operator's own machine

Nothing here imports from `app.api`: a provider is a detail of the two planes
that use it, never of the HTTP surface above them.
"""
