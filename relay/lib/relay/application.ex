defmodule Relay.Application do
  @moduledoc false
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    port = String.to_integer(System.get_env("PORT") || "4000")

    children = [
      {Phoenix.PubSub, name: Relay.PubSub},
      # one host per room — registration dies with the socket process
      {Registry, keys: :unique, name: Relay.Hosts},
      {Bandit, plug: Relay.Router, scheme: :http, port: port}
    ]

    Logger.info("gabriele relay listening on :#{port}")
    Supervisor.start_link(children, strategy: :one_for_one, name: Relay.Supervisor)
  end
end
