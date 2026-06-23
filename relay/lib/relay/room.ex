defmodule Relay.Room do
  @moduledoc """
  Per-room authoritative session state — the backend source of truth, shared by
  every client.

  One GenServer per room (keyed by sha256(token), via `Relay.Rooms`). It:

    * holds the canonical session list + profiles + per-session scrollback,
      learned by parsing the host's frames;
    * is the single ordered egress: a host frame is cached THEN fanned out, so a
      cached `focus`/`sync` answer can never be staler than bytes already sent;
    * answers `sync` and `focus` from cache so ANY client gets full state
      instantly without involving the host — late joins, reconnects, all converge;
    * routes client→host frames, and **drops `new` when no host is registered**
      (the phantom-channel fix: a stale client can't spawn a channel into thin air);
    * enforces one host per room, bounds memory (per-session + per-room caps),
      and evicts itself when idle.
  """
  use GenServer
  require Logger
  alias Phoenix.PubSub

  @buf_cap 200 * 1024          # per-session scrollback, mirrors the bridge
  @max_sessions 64             # per-room session ceiling (bounds total memory)
  @idle_ms 10 * 60 * 1000      # terminate a room with no host and no clients after this

  # ---- API ----
  def start_link(room), do: GenServer.start_link(__MODULE__, room, name: via(room))

  @doc "Find or start the room process for a room name."
  def ensure(room) do
    case Registry.lookup(Relay.Rooms, room) do
      [{pid, _}] -> pid
      [] ->
        case DynamicSupervisor.start_child(Relay.RoomSup, {__MODULE__, room}) do
          {:ok, pid} -> pid
          {:error, {:already_started, pid}} -> pid
        end
    end
  end

  def attach_host(room, pid), do: GenServer.call(ensure(room), {:attach_host, pid})
  def attach_client(room, pid, role), do: GenServer.call(ensure(room), {:attach_client, pid, role})
  def host_frame(room, text), do: GenServer.cast(ensure(room), {:host_frame, text})
  def client_frame(room, from, text), do: GenServer.cast(ensure(room), {:client_frame, from, text})

  # ---- init ----
  @impl true
  def init(room) do
    {:ok, %{room: room, host: nil, clients: %{}, sessions: %{},
            profiles: [], default: nil, buffers: %{}, evict: nil}}
  end

  # ---- attach / presence ----
  @impl true
  def handle_call({:attach_host, pid}, _from, %{host: host} = state) do
    # last-host-wins: a reconnecting bridge's predecessor is usually a HALF-OPEN zombie still
    # holding the slot (common through a VPN/proxy). Rejecting the newcomer as :busy made it
    # retry-flap until the zombie was reaped (~a minute), and every reconnect storm reset/garbled
    # attached clients. So evict the old socket and let the newest connection take over.
    if is_pid(host) and host != pid and Process.alive?(host), do: send(host, :evicted)
    Process.monitor(pid)
    state = cancel_evict(%{state | host: pid})
    send(pid, {:relay, ~s({"type":"sync"})})                 # refresh cache from the new host's truth
    PubSub.broadcast(Relay.PubSub, down(state.room), {:relay, ~s({"type":"host_up"})})
    Logger.info("host up #{slug(state.room)}")
    {:reply, :ok, state}
  end

  def handle_call({:attach_client, pid, role}, _from, state) do
    Process.monitor(pid)
    state = cancel_evict(%{state | clients: Map.put(state.clients, pid, role)})
    send(pid, {:relay, sessions_json(state)})                # full state immediately, from cache
    {:reply, {:ok, state.host != nil}, state}
  end

  def handle_call(:stats, _from, state) do
    bytes = state.buffers |> Map.values() |> Enum.reduce(0, fn %{snap: s, deltas: dl}, acc -> byte_size(s) + byte_size(dl) + acc end)
    {:reply, %{host: state.host != nil, clients: map_size(state.clients),
               sessions: map_size(state.sessions), buffer_kb: div(bytes, 1024)}, state}
  end

  # ---- host frames: cache, THEN broadcast (append-before-fanout) ----
  # Exception: `snapshot` is cache-ONLY. A serialized full-screen frame is for the
  # focus/replay path (a newly-attached client resets + paints it once). Fanning it
  # out to ALREADY-attached clients mid-stream is corrupting: the client's reset
  # drops any escape split across two deltas (the next delta's tail renders as
  # literal text, e.g. `244m`) and desyncs the cursor so the TUI's relative redraws
  # stack. Attached clients get a pure delta stream — like a real terminal.
  @impl true
  def handle_cast({:host_frame, text}, state) do
    decoded = Jason.decode(text)
    state = apply_host(state, decoded)
    case decoded do
      {:ok, %{"type" => "snapshot"}} -> :ok
      _ -> PubSub.broadcast(Relay.PubSub, down(state.room), {:relay, text})
    end
    {:noreply, state}
  end

  # ---- client frames: answer from cache or route to the host ----
  def handle_cast({:client_frame, from, text}, state) do
    role = Map.get(state.clients, from, "view")              # control = drive · view = read-only
    case Jason.decode(text) do
      {:ok, %{"type" => "ping"} = m} ->                       # latency probe — echo straight back
        send(from, {:relay, Jason.encode!(%{"type" => "pong", "t" => m["t"]})})

      {:ok, %{"type" => "sync"}} ->
        send(from, {:relay, sessions_json(state)})

      {:ok, %{"type" => "focus", "id" => id}} ->
        case Map.get(state.buffers, id) do
          %{snap: snap, deltas: deltas} -> send(from, {:relay, snapshot_json(id, snap <> deltas)})  # coherent frame + faithful tail
          _ -> if role == "control", do: to_host(state, text)                                       # cache miss -> ask the host (control only)
        end

      {:ok, %{"type" => "new"}} ->
        # phantom fix + role gate: only a control client, with a host present, under cap
        if role == "control" and is_pid(state.host) and map_size(state.sessions) < @max_sessions, do: to_host(state, text)

      {:ok, %{"type" => type}} when type in ["input", "resize", "kill", "close"] ->
        if role == "control", do: to_host(state, text)       # view clients cannot drive sessions

      _ ->
        :ok                                                  # unknown frames are never forwarded to the host
    end

    {:noreply, state}
  end

  # ---- monitors: host/client death + idle eviction ----
  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    state =
      cond do
        state.host == pid ->
          PubSub.broadcast(Relay.PubSub, down(state.room), {:relay, ~s({"type":"host_down"})})
          Logger.info("host down #{slug(state.room)}")
          maybe_evict(%{state | host: nil})

        Map.has_key?(state.clients, pid) ->
          maybe_evict(%{state | clients: Map.delete(state.clients, pid)})

        true ->
          state
      end

    {:noreply, state}
  end

  def handle_info(:evict, %{host: nil, clients: c} = state) when map_size(c) == 0 do
    Logger.info("evict idle room #{slug(state.room)}")
    {:stop, :normal, state}
  end

  def handle_info(:evict, state), do: {:noreply, %{state | evict: nil}}
  def handle_info(_msg, state), do: {:noreply, state}

  # ---- cache updates from host frames (takes the already-decoded frame) ----
  defp apply_host(state, {:ok, %{"type" => "sessions"} = m}) do
    sessions = Map.new(m["sessions"] || [], &{&1["id"], &1})
    %{state |
      sessions: sessions,
      profiles: m["profiles"] || state.profiles,
      default: m["defaultProfile"] || state.default,
      buffers: Map.take(state.buffers, Map.keys(sessions))}  # prune dead-PTY scrollback on (re)sync
  end

  defp apply_host(state, {:ok, %{"type" => "session", "meta" => meta}}) when is_map(meta),
    do: %{state | sessions: Map.put(state.sessions, meta["id"], meta)}

  defp apply_host(state, {:ok, %{"type" => "closed", "id" => id}}),
    do: %{state | sessions: Map.delete(state.sessions, id), buffers: Map.delete(state.buffers, id)}

  defp apply_host(state, {:ok, %{"type" => "exit", "id" => id}}) do
    case Map.get(state.sessions, id) do
      nil -> state
      meta -> %{state | sessions: Map.put(state.sessions, id, Map.put(meta, "state", "exited"))}
    end
  end

  # focus-replay cache per session = %{snap: <serialized full frame>, deltas: <faithful continuation>}.
  # The snapshot is replay-authoritative; the deltas are a byte-exact continuation of it. NEVER head-chop
  # the concatenation (that eats the frame's reset prefix and splits an escape) — when it would exceed the
  # cap, shed the deltas instead (the snapshot alone is a coherent frame; the bridge re-seeds on settle).
  # Before the first snapshot we keep a raw tail so an early focus still replays something.
  defp apply_host(state, {:ok, %{"type" => "data", "id" => id, "data" => d}}) when is_binary(d) do
    %{snap: snap, deltas: deltas} = Map.get(state.buffers, id, %{snap: "", deltas: ""})
    deltas = deltas <> d
    deltas =
      cond do
        byte_size(snap) + byte_size(deltas) <= @buf_cap -> deltas
        snap != "" -> ""
        true -> cap(deltas)
      end
    %{state | buffers: Map.put(state.buffers, id, %{snap: snap, deltas: deltas})}
  end

  defp apply_host(state, {:ok, %{"type" => "snapshot", "id" => id, "data" => d}}) when is_binary(d),
    do: %{state | buffers: Map.put(state.buffers, id, %{snap: d, deltas: ""})}

  defp apply_host(state, _), do: state

  # ---- helpers ----
  defp to_host(%{host: host}, text) when is_pid(host), do: send(host, {:relay, text})
  defp to_host(_state, _text), do: :ok

  defp sessions_json(state) do
    sessions = state.sessions |> Map.values() |> Enum.sort_by(&(&1["startedAt"] || 0))
    Jason.encode!(%{"type" => "sessions", "sessions" => sessions,
                    "profiles" => state.profiles, "defaultProfile" => state.default})
  end

  defp snapshot_json(id, buf), do: Jason.encode!(%{"type" => "snapshot", "id" => id, "data" => buf})

  defp cap(b) when byte_size(b) > @buf_cap, do: binary_part(b, byte_size(b) - @buf_cap, @buf_cap)
  defp cap(b), do: b

  defp maybe_evict(%{host: nil, clients: c} = state) when map_size(c) == 0 do
    %{cancel_evict(state) | evict: Process.send_after(self(), :evict, @idle_ms)}
  end

  defp maybe_evict(state), do: cancel_evict(state)

  defp cancel_evict(%{evict: ref} = state) when is_reference(ref) do
    Process.cancel_timer(ref)
    %{state | evict: nil}
  end

  defp cancel_evict(state), do: state

  defp via(room), do: {:via, Registry, {Relay.Rooms, room}}
  defp down(room), do: "down:" <> room
  defp slug(room), do: String.slice(room, 0, 8)
end
