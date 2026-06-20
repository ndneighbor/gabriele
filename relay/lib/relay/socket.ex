defmodule Relay.Socket do
  @moduledoc """
  Protocol-dumb relay socket. Each connection sends a first `hello` message:

      {"type":"hello","role":"host"|"client","token":"<shared secret>"}

  The token must equal GABRIELE_RELAY_SECRET. The room is derived from the token,
  so the same secret = the same room. After auth the relay just pipes raw text:
  host → all clients (PubSub fan-out), client → the host (Registry lookup). It
  injects only `host_up` / `host_down` so clients know whether the Mac bridge is live.
  """
  @behaviour WebSock
  require Logger
  alias Phoenix.PubSub

  @ping_ms 30_000

  @impl true
  def init(_opts) do
    schedule_ping()
    {:ok, %{authed: false, role: nil, room: nil}}
  end

  # ---- before auth: only a valid hello gets through ----
  @impl true
  def handle_in({text, [opcode: :text]}, %{authed: false} = state) do
    secret = System.get_env("GABRIELE_RELAY_SECRET")

    with {:ok, %{"type" => "hello", "token" => token} = msg} <- Jason.decode(text),
         true <- is_binary(secret) and secret != "",
         true <- token == secret do
      auth(msg["role"], room_for(token), state)
    else
      _ -> {:stop, :normal, state}
    end
  end

  # ---- after auth: pipe by role ----
  def handle_in({text, [opcode: :text]}, %{authed: true, role: "host", room: room} = state) do
    PubSub.broadcast(Relay.PubSub, down(room), {:relay, text})
    {:ok, state}
  end

  def handle_in({text, [opcode: :text]}, %{authed: true, role: "client", room: room} = state) do
    case Registry.lookup(Relay.Hosts, room) do
      [{host, _}] -> send(host, {:relay, text})
      _ -> :ok
    end

    {:ok, state}
  end

  def handle_in(_frame, state), do: {:ok, state}

  defp auth("host", room, state) do
    case Registry.register(Relay.Hosts, room, nil) do
      {:ok, _} ->
        PubSub.broadcast(Relay.PubSub, down(room), {:relay, ~s({"type":"host_up"})})
        Logger.info("host up #{String.slice(room, 0, 8)}")
        {:push, {:text, ~s({"type":"hello_ok","role":"host"})},
         %{state | authed: true, role: "host", room: room}}

      {:error, _} ->
        {:stop, :normal, state}
    end
  end

  defp auth("client", room, state) do
    PubSub.subscribe(Relay.PubSub, down(room))
    present = match?([_ | _], Registry.lookup(Relay.Hosts, room))

    {:push, {:text, ~s({"type":"hello_ok","role":"client","host_present":#{present}})},
     %{state | authed: true, role: "client", room: room}}
  end

  defp auth(_role, _room, state), do: {:stop, :normal, state}

  # ---- mailbox ----
  @impl true
  def handle_info({:relay, text}, state), do: {:push, {:text, text}, state}

  def handle_info(:ping, state) do
    schedule_ping()
    {:push, {:ping, ""}, state}
  end

  def handle_info(_msg, state), do: {:ok, state}

  @impl true
  def terminate(_reason, %{role: "host", room: room}) when is_binary(room) do
    PubSub.broadcast(Relay.PubSub, down(room), {:relay, ~s({"type":"host_down"})})
    :ok
  end

  def terminate(_reason, _state), do: :ok

  defp schedule_ping, do: Process.send_after(self(), :ping, @ping_ms)
  defp room_for(token), do: Base.encode16(:crypto.hash(:sha256, token), case: :lower)
  defp down(room), do: "down:" <> room
end
