defmodule Relay.Metrics do
  @moduledoc """
  Lightweight relay observability for `/metrics`. No heavy deps — just BEAM
  introspection + a quick stats call per room. The canary metric is each Room's
  `mailbox` (message-queue length): if it backs up, that room's GenServer is the
  serialization bottleneck under a chatty session.
  """

  def gather do
    rooms =
      Registry.select(Relay.Rooms, [{{:"$1", :"$2", :_}, [], [{{:"$1", :"$2"}}]}])
      |> Enum.map(&room_stat/1)

    %{
      beam: %{
        process_count: :erlang.system_info(:process_count),
        memory_mb: Float.round(:erlang.memory(:total) / 1_048_576, 1),
        run_queue: :erlang.statistics(:run_queue)
      },
      room_count: length(rooms),
      rooms: rooms
    }
  end

  defp room_stat({name, pid}) do
    # Process.info reads the mailbox from OUTSIDE the process — the true backlog,
    # not 0-after-it-drains like a GenServer.call would report.
    info = Process.info(pid, [:message_queue_len, :memory]) || []
    counts =
      try do
        GenServer.call(pid, :stats, 200)
      catch
        _, _ -> %{}   # jammed room => call times out; mailbox above still shows it
      end

    %{
      room: String.slice(name, 0, 8),
      mailbox: info[:message_queue_len],
      memory_kb: div(info[:memory] || 0, 1024),
      host: Map.get(counts, :host),
      clients: Map.get(counts, :clients),
      sessions: Map.get(counts, :sessions),
      buffer_kb: Map.get(counts, :buffer_kb)
    }
  end
end
