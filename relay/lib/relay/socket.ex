defmodule Relay.Socket do
  @moduledoc """
  Relay socket. Each connection sends a first `hello`:

      {"type":"hello","role":"host"|"client","token":"<shared secret>"}

  The token must equal GABRIELE_RELAY_SECRET; the room = sha256(token). After auth
  the socket is thin — it hands every frame to the room's `Relay.Room` GenServer,
  which holds authoritative session state, fans host→clients out via PubSub, and
  answers `sync`/`focus` from cache. Clients subscribe to `down:<room>` for fan-out;
  the Room delivers everything (incl. unicast cache answers) as `{:relay, text}`.

  Liveness: we ping every 30s and the socket's idle timeout (router.ex) reaps any
  connection that stops pong-ing — so dead/half-open clients unsubscribe instead of
  lingering as zombies (the orphaned-subscriber half of the phantom-channel bug).
  """
  @behaviour WebSock

  @impl true
  def init(_opts) do
    schedule_ping()
    {:ok, %{authed: false, role: nil, room: nil, missed: 0}}
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

  # ---- after auth: hand the frame to the room ----
  def handle_in({text, [opcode: :text]}, %{authed: true, role: "host", room: room} = state) do
    Relay.Room.host_frame(room, text)
    {:ok, state}
  end

  def handle_in({text, [opcode: :text]}, %{authed: true, role: "client", room: room} = state) do
    Relay.Room.client_frame(room, self(), text)
    {:ok, state}
  end

  def handle_in(_frame, state), do: {:ok, state}

  defp auth("host", room, state) do
    case Relay.Room.attach_host(room, self()) do
      :ok ->
        {:push, {:text, ~s({"type":"hello_ok","role":"host"})},
         %{state | authed: true, role: "host", room: room}}

      {:error, :busy} ->
        {:stop, :normal, state}                              # one host per room
    end
  end

  defp auth("client", room, state) do
    Phoenix.PubSub.subscribe(Relay.PubSub, "down:" <> room)
    {:ok, present} = Relay.Room.attach_client(room, self())

    {:push, {:text, ~s({"type":"hello_ok","role":"client","host_present":#{present}})},
     %{state | authed: true, role: "client", room: room}}
  end

  defp auth(_role, _room, state), do: {:stop, :normal, state}

  # ---- liveness: pong resets the miss counter; 2 misses in a row => reap ----
  @impl true
  def handle_control({_data, [opcode: :pong]}, state), do: {:ok, %{state | missed: 0}}
  def handle_control(_frame, state), do: {:ok, state}

  # ---- mailbox: the Room (and PubSub) deliver frames as {:relay, text} ----
  @impl true
  def handle_info({:relay, text}, state), do: {:push, {:text, text}, state}

  def handle_info(:ping, %{missed: missed} = state) when missed >= 2 do
    {:stop, :normal, state}                                  # client stopped pong-ing — reap the zombie
  end

  def handle_info(:ping, state) do
    schedule_ping()
    {:push, {:ping, ""}, %{state | missed: state.missed + 1}}
  end

  def handle_info(_msg, state), do: {:ok, state}

  # The Room monitors host/client pids, so it learns of disconnects on its own;
  # no terminate broadcast needed here.
  @impl true
  def terminate(_reason, _state), do: :ok

  defp schedule_ping, do: Process.send_after(self(), :ping, ping_ms())
  defp ping_ms, do: String.to_integer(System.get_env("GABRIELE_PING_MS") || "30000")
  defp room_for(token), do: Base.encode16(:crypto.hash(:sha256, token), case: :lower)
end
