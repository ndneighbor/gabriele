defmodule Relay.MixProject do
  use Mix.Project

  def project do
    [
      app: :relay,
      version: "0.1.0",
      elixir: "~> 1.16",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      mod: {Relay.Application, []},
      extra_applications: [:logger, :crypto]
    ]
  end

  defp deps do
    [
      {:bandit, "~> 1.5"},
      {:websock_adapter, "~> 0.5"},
      {:plug, "~> 1.16"},
      {:phoenix_pubsub, "~> 2.1"},
      {:jason, "~> 1.4"}
    ]
  end
end
