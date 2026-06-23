defmodule Relay.Router do
  @moduledoc false
  use Plug.Router

  plug(:match)
  plug(:dispatch)

  get "/" do
    send_resp(conn, 200, "gabriele relay")
  end

  get "/healthz" do
    send_resp(conn, 200, "ok")
  end

  get "/metrics" do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(Relay.Metrics.gather()))
  end

  get "/ws" do
    conn
    |> WebSockAdapter.upgrade(Relay.Socket, %{}, timeout: 3_600_000)
    |> halt()
  end

  match _ do
    send_resp(conn, 404, "not found")
  end
end
