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
         {:ok, role, room} <- verify(token, msg["role"], secret) do
      auth(role, room, state)
    else
      _ -> {:stop, :normal, state}
    end
  end

  # ---- after auth: hand the frame to the room ----
  def handle_in({text, [opcode: :text]}, %{authed: true, role: "host", room: room} = state) do
    Relay.Room.host_frame(room, text)
    {:ok, state}
  end

  def handle_in({text, [opcode: :text]}, %{authed: true, role: role, room: room} = state) when role in ["control", "view"] do
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

  defp auth(role, room, state) when role in ["control", "view"] do
    Phoenix.PubSub.subscribe(Relay.PubSub, "down:" <> room)
    {:ok, present} = Relay.Room.attach_client(room, self(), role)

    {:push, {:text, ~s({"type":"hello_ok","role":"#{role}","host_present":#{present}})},
     %{state | authed: true, role: role, room: room}}
  end

  defp auth(_role, _room, state), do: {:stop, :normal, state}

  # Auth: the raw secret (legacy — role from hello: host, else control) OR a signed
  # per-device token "<payload-b64url>.<hmac-b64url>" carrying {role, device}.
  defp verify(token, hello_role, secret) when is_binary(token) and is_binary(secret) and secret != "" do
    if Plug.Crypto.secure_compare(token, secret) do
      {:ok, if(hello_role == "host", do: "host", else: "control"), room_for(secret)}
    else
      verify_signed(token, secret)
    end
  end

  defp verify(_token, _role, _secret), do: :error

  defp verify_signed(token, secret) do
    with [payload, sig] <- String.split(token, ".", parts: 2),
         expected <- Base.url_encode64(:crypto.mac(:hmac, :sha256, secret, payload), padding: false),
         true <- Plug.Crypto.secure_compare(expected, sig),
         {:ok, json} <- Base.url_decode64(payload, padding: false),
         {:ok, %{"role" => role, "device" => device}} <- Jason.decode(json),
         true <- role in ["host", "control", "view"],
         false <- revoked?(device) do
      {:ok, role, room_for(secret)}
    else
      _ -> :error
    end
  end

  defp revoked?(device) do
    (System.get_env("GABRIELE_REVOKED") || "")
    |> String.split(",", trim: true)
    |> Enum.any?(&(String.trim(&1) == device))
  end

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
