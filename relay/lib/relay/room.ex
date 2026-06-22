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
  def attach_client(room, pid), do: GenServer.call(ensure(room), {:attach_client, pid})
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
    if is_pid(host) and Process.alive?(host) do
      {:reply, {:error, :busy}, state}                       # one host per room
    else
      Process.monitor(pid)
      state = cancel_evict(%{state | host: pid})
      send(pid, {:relay, ~s({"type":"sync"})})               # refresh cache from the host's truth
      PubSub.broadcast(Relay.PubSub, down(state.room), {:relay, ~s({"type":"host_up"})})
      Logger.info("host up #{slug(state.room)}")
      {:reply, :ok, state}
    end
  end

  def handle_call({:attach_client, pid}, _from, state) do
    Process.monitor(pid)
    state = cancel_evict(%{state | clients: Map.put(state.clients, pid, true)})
    send(pid, {:relay, sessions_json(state)})                # full state immediately, from cache
    {:reply, {:ok, state.host != nil}, state}
  end

  # ---- host frames: cache, THEN broadcast (append-before-fanout) ----
  @impl true
  def handle_cast({:host_frame, text}, state) do
    state = apply_host(state, text)
    PubSub.broadcast(Relay.PubSub, down(state.room), {:relay, text})
    {:noreply, state}
  end

  # ---- client frames: answer from cache or route to the host ----
  def handle_cast({:client_frame, from, text}, state) do
    case Jason.decode(text) do
      {:ok, %{"type" => "sync"}} ->
        send(from, {:relay, sessions_json(state)})

      {:ok, %{"type" => "focus", "id" => id}} ->
        case Map.get(state.buffers, id) do
          nil -> to_host(state, text)                         # no cached scrollback yet — let the host supply it
          buf -> send(from, {:relay, snapshot_json(id, buf)})
        end

      {:ok, %{"type" => "new"}} ->
        # the phantom fix: only spawn when a real host is present and we're under cap
        if state.host && map_size(state.sessions) < @max_sessions, do: to_host(state, text)

      {:ok, _} ->
        to_host(state, text)                                 # input/resize/kill/close/etc

      _ ->
        :ok
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

  # ---- cache updates from host frames ----
  defp apply_host(state, text) do
    case Jason.decode(text) do
      {:ok, %{"type" => "sessions"} = m} ->
        sessions = Map.new(m["sessions"] || [], &{&1["id"], &1})
        %{state |
          sessions: sessions,
          profiles: m["profiles"] || state.profiles,
          default: m["defaultProfile"] || state.default,
          buffers: Map.take(state.buffers, Map.keys(sessions))}  # prune dead-PTY scrollback on (re)sync

      {:ok, %{"type" => "session", "meta" => meta}} when is_map(meta) ->
        %{state | sessions: Map.put(state.sessions, meta["id"], meta)}

      {:ok, %{"type" => "closed", "id" => id}} ->
        %{state | sessions: Map.delete(state.sessions, id), buffers: Map.delete(state.buffers, id)}

      {:ok, %{"type" => "exit", "id" => id}} ->
        case Map.get(state.sessions, id) do
          nil -> state
          meta -> %{state | sessions: Map.put(state.sessions, id, Map.put(meta, "state", "exited"))}
        end

      {:ok, %{"type" => "data", "id" => id, "data" => d}} when is_binary(d) ->
        %{state | buffers: Map.update(state.buffers, id, cap(d), &cap(&1 <> d))}

      {:ok, %{"type" => "snapshot", "id" => id, "data" => d}} when is_binary(d) ->
        %{state | buffers: Map.put(state.buffers, id, cap(d))}

      _ ->
        state
    end
  end

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
