---
title: "Part 5: Reading Slurm Node States in ParallelCluster"
author: Bailey Sohyeon Cho
layout: post
lang: en
lang_peer: /pages/pcluster-series-5-node-states-ko/
---

# Reading Slurm Node States in ParallelCluster

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 4: Building a Custom AMI](/pages/pcluster-series-3-custom-ami/) | [Part 6: Monitoring →](/pages/pcluster-series-5-monitoring-en/)

`sinfo -N` gives you a state column like `idle~`, `down#`, or `alloc*`. These aren't arbitrary strings — each character is a specific flag. Understanding them is the difference between knowing your cluster is healthy and thinking it is.

---

## Base states

Every node has a base state:

| Base state | Meaning |
|-----------|---------|
| `idle` | Ready to accept jobs |
| `alloc` | Running a job |
| `mixed` | Some CPUs/GPUs allocated, some free |
| `down` | Unavailable — clustermgtd will act on this |
| `drain` | Marked for draining — no new jobs accepted |
| `draining` | Drain in progress, current job still running |
| `drained` | Drain complete, no jobs, waiting for action |
| `completing` | Job finished, cleanup in progress |
| `unknown` | Node state cannot be determined |

---

## Compound state suffixes

ParallelCluster adds suffixes to the base state. These reflect additional conditions. Multiple suffixes can appear together (e.g., `down~*`).

| Suffix | Flag name | Meaning |
|--------|-----------|---------|
| `~` | CLOUD | Node is in the cloud power-saving pool. **No EC2 instance exists yet.** Slurm knows about it but it's not running. |
| `#` | COMPLETING | Node is in the middle of job cleanup or bootstrap. |
| `%` | POWER_SAVING | Actively powering down toward CLOUD state. |
| `!` | POWERED_DOWN | Instance has been explicitly powered down by clustermgtd. |
| `*` | NOT_RESPONDING | Node is registered in Slurm but not sending heartbeats. |
| `+` | DRAIN | Drain flag is set on the node. |

Common combinations you'll see in practice:

| What you see | What it means |
|-------------|---------------|
| `idle~` | Powered down, no EC2 instance. Job submission will trigger a launch. |
| `idle#` | EC2 is booting or running bootstrap. Not ready yet. |
| `idle%` | Powering down. Will become `idle~` shortly. |
| `idle!` | Explicitly powered down by clustermgtd. |
| `idle*` | Slurm thinks it's idle but node isn't responding. |
| `down~` | Powered down AND in DOWN state. Needs `power_down_force` + `resume`. |
| `down#` | Booting but in DOWN state — bootstrap failure likely. |
| `alloc` | Job running, fully healthy. |
| `alloc#` | Job allocated but node still configuring (cfn-signal not yet received). |
| `drain+` | Drain flag set, current jobs can still finish. |

---

## The IDLE+CLOUD trap

`idle~` is the most important state to understand correctly.

When you see `idle~`, Slurm is reporting the node as available. But there is no EC2 instance running. The node exists only as a record in Slurm's state database. It's a placeholder for a future instance that will be launched on demand when a job needs it.

This has two practical implications.

**For job submission**: submitting a job to an `idle~` node is fine — ParallelCluster will launch the EC2 instance automatically. But it will take 8 to 20 minutes before the job actually starts running. If you're expecting immediate execution, you'll be waiting longer than expected.

**For monitoring dashboards**: if you count `idle~` nodes as "healthy" or "available" in a Grafana stat panel, your dashboard will show capacity that doesn't actually exist yet. A cluster with 4 nodes where 3 are `idle~` and 1 is `alloc` is not a healthy 4-node cluster — it's a 1-node cluster with 3 nodes pending launch.

The correct Prometheus query for nodes that are actually running and healthy:

```promql
# Nodes that have a real EC2 instance and are ready
slurm_node_count_per_state{state=~"idle|alloc.*|mixed.*|completing.*"}

# Nodes that are powered down (no EC2 instance)
slurm_node_count_per_state{state=~"idle~|idle!|idle%|powered_down.*"}
```

Keep these as separate panels. Don't add them together.

---

## clustermgtd decision table

clustermgtd runs a polling loop roughly every 60 seconds. Here's what it does with each node state:

| Node state | clustermgtd action |
|-----------|-------------------|
| `idle` (static node) | Healthy. No action. |
| `idle~` | Healthy. EC2 will launch on job arrival. |
| `idle*` | NOT_RESPONDING. If persistent: reboot (static) or terminate (dynamic). |
| `down` | Unhealthy. Reboot (static) or terminate (dynamic). |
| `down~` | Was powered down but in DOWN state. Will attempt resume. |
| `drain+` (idle) | `terminate_drain_nodes=True` (default): terminate instance. The drain state is preserved on the Slurm node record and inherited by the next instance — see drain loop below. |
| `drain+` (running job) | Waits for job to finish, then terminates. |
| Bootstrap timeout | Node didn't send cfn-signal in `ComputeNodeBootstrapTimeout`. Terminate. |
| EC2 health check fail | Hardware impairment detected. Terminate regardless of Slurm state. |

---

## The drain state inheritance loop

This is one of the nastier failure modes in ParallelCluster, and it's not obvious from the docs.

When a static node goes into drain state and becomes idle (job finished or no job), clustermgtd terminates the instance (default `terminate_drain_nodes=True`). A new instance launches to replace it. But here's the problem: Slurm manages nodes by name, not by instance ID. The new instance gets the same node name. And the node name still has `drain+` set in Slurm's state database. So the new instance is born drained. clustermgtd sees it: idle + drain = unhealthy. Terminates again.

```
Node goes drain → job finishes
→ clustermgtd: idle+drain = unhealthy → terminate
→ new instance launches with same node name
→ Slurm node record: still has drain flag
→ new instance: born in drain state
→ clustermgtd: terminate immediately
→ loop
```

On a single Capacity Block reservation, the terminated instance releases the slot. The next launch may fail with `ReservationCapacityExceeded` because the previous instance is still `shutting-down` and holding the slot. You can end up waiting 30 to 40 minutes.

**The fix**: clear drain before the instance terminates.

```bash
# Check for drained nodes
sinfo -N | grep -E "drain|drain+"

# Clear drain state before clustermgtd acts
scontrol update nodename=<NODE> state=resume

# If node is already terminated and loop has started:
scontrol update nodename=<NODE> state=power_down_force
sleep 10
scontrol update nodename=<NODE> state=resume
# Then wait for CB slot to free up before new instance can launch
```

---

## Job cancel to new job: the 60-second rule

When you `scancel` a job, the processes are killed but slurmd and slurmstepd need time to clean up process groups, release GPU handles, and update their internal state. If a new job lands on the node before cleanup finishes, slurmd throws an "Unspecified error". clustermgtd treats this as a health failure and terminates the instance.

```bash
# Wrong — will kill the node
scancel <JOB_ID>
sbatch next_job.sh

# Correct
scancel <JOB_ID>
sleep 60
# Check node is cleanly idle (no suffix)
sinfo -N | grep <NODE>
# Wait for plain "idle" with no ~ # % * suffix
sleep 120
sbatch next_job.sh
```

The minimum wait after `scancel` is 60 seconds. After heavy GPU workloads (large all-reduce operations, high memory throughput), 2 to 3 minutes is safer.

---

## Reading node states programmatically

```bash
# Overview — state per node
sinfo -N --format="%N %T %O %e" --noheader

# Detailed node info including reason for DOWN/DRAIN
scontrol show node <nodename>

# Watch for state changes (refresh every 5s)
watch -n 5 "sinfo -N"

# List all nodes in problematic states
sinfo -N | grep -E "down|drain|unknown|not_respond"

# Prometheus (via slurm_exporter)
# slurm_node_count_per_state{state="idle"}        # truly idle instances
# slurm_node_count_per_state{state="idle~"}       # powered down
# slurm_node_state_reason{node="...",reason="..."}  # why a node is down/drain
```

---

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 4: Building a Custom AMI](/pages/pcluster-series-3-custom-ami/) | You are here: **Part 5: Reading Node States** | [Part 6: Monitoring →](/pages/pcluster-series-5-monitoring-en/)
{: .block-tip }
