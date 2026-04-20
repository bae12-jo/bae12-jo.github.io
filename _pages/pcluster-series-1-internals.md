---
title: "Part 2: How AWS ParallelCluster Works Under the Hood"
author: Bailey Sohyeon Cho
layout: post
lang: en
lang_peer: /pages/pcluster-series-1-internals-ko/
---

# How AWS ParallelCluster Actually Works Under the Hood

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 1: What Kind of Service Is ParallelCluster?](/pages/pcluster-series-0-what-is-pcluster-en/) | [Part 3: Why Your p6-b200 Nodes Keep Rebooting →](/pages/pcluster-series-2-reboots/)

When you run `pcluster create-cluster`, things happen inside your nodes that most engineers never see. The same AMI and the same scripts behave completely differently on a standalone EC2 instance than they do inside a ParallelCluster. This post explains what's actually happening and why.

---

## What actually happens from create-cluster to slurmd

```
pcluster create-cluster
    ↓
CloudFormation creates the stack
(HeadNode, ComputeNodes, VPC, security groups — everything defined in your config)
    ↓
EC2 launches instances with the pcluster AMI
    ↓
cloud-init runs on each instance
  phase 1: executes UserData (basic OS setup)
  phase 2: executes the cinc bootstrap script
    ↓
cinc runs the pcluster cookbooks
(nvidia_config.rb, slurm_install.rb, efa_driver.rb, ...)
    ↓
cinc finalize phase checks for /var/run/reboot-required
  → if found: reboots the node
    ↓
OnNodeStart hook runs (from S3, while cinc is still in progress)
    ↓
cinc finalize continues: mounts FSx Lustre
    ↓
OnNodeConfigured hook runs
    ↓
cfn-signal sent to CloudFormation: "this node is ready"
    ↓
slurmd starts on compute nodes
slurmctld starts on HeadNode
    ↓
clustermgtd detects nodes and marks them idle
```

If any step fails or hangs, the whole cluster creation stalls indefinitely.

---

## cloud-init: the standard EC2 bootstrap layer

cloud-init is the industry-standard tool for initializing cloud instances. It runs on almost every EC2 AMI automatically on first boot. In ParallelCluster, cloud-init does two things in sequence.

Phase 1 runs UserData — the script you can optionally pass at instance launch. ParallelCluster uses this to do basic OS-level setup: install packages, configure the network, prepare the filesystem layout.

Phase 2 runs the cinc bootstrap. This is where the real work happens. ParallelCluster embeds a cinc invocation in cloud-init that pulls down the pcluster cookbooks and runs them. There's no explicit trigger you set up. It happens automatically because it's baked into the pcluster AMI's cloud-init configuration.

---

## cinc: why it runs and what it does

cinc is a fork of Chef Infra Client, the configuration management tool. ParallelCluster chose Chef/cinc because GPU cluster setup involves dozens of interdependent configuration steps that need to run in a precise order. A shell script would be brittle. cinc's declarative cookbook model lets pcluster define the desired state and have it enforced idempotently on every node.

You don't invoke cinc. You don't configure it. It runs because the pcluster AMI has it installed and cloud-init calls it. By the time your OnNodeConfigured script starts, cinc has already finished its work.

On GPU nodes, cinc runs `nvidia_config.rb`, the most consequential cookbook for our purposes:

```ruby
gdrcopy :configure
  # loads the gdrdrv kernel module
  # enables GPU Direct RDMA, which is required for NVLink, EFA, and fabric manager
  # this must succeed before fabric_manager runs

fabric_manager :configure
  # starts nvidia-fabricmanager
  # if fabricmanager is already running: no-op, cinc moves on
  # if fabricmanager is masked (systemctl mask): always returns exit code 1, cinc fails FATALLY
  # if fabricmanager is disabled: attempts to start it

run_nvidiasmi
  # runs nvidia-smi to validate GPU discovery
  # if GPUs aren't visible here, they won't be visible to Slurm either

efa_driver :setup
  # installs EFA drivers if not already present

slurm_install :configure
  # installs Slurm, writes slurm.conf
```

After all cookbooks complete, cinc runs a finalize phase:

```
cinc finalize:
  1. check /var/run/reboot-required
     → if the file exists: reboot immediately
  2. mount FSx Lustre filesystem
```

> ##### WARNING
>
> If cinc installs any package that writes `/var/run/reboot-required`, the finalize phase will reboot your node. Your OnNodeConfigured script never runs. From the outside it looks like a bootstrap timeout. This is covered in detail in Part 3.
{: .block-warning }

---

## What timing matters: OnNodeStart vs OnNodeConfigured

These two hooks run at very different points in the sequence:

```
cloud-init (UserData) finishes
    ↓
cinc starts
    ↓
OnNodeStart runs  ← runs here, WHILE cinc is executing
    ↓
cinc finishes all cookbooks + finalize
    ↓
cfn-signal sent
    ↓
OnNodeConfigured runs  ← runs here, AFTER cinc is fully done
    ↓
slurmd starts
```

OnNodeStart executes while cinc is still in the middle of setting up the system. GPU drivers haven't been loaded. GDRcopy hasn't configured. nvidia-fabricmanager hasn't started. Anything that depends on those being in place will fail.

OnNodeConfigured runs after cinc has finished everything. This is where all GPU-related work belongs.

Concrete examples of what goes where:

```yaml
OnNodeStart: |
  #!/bin/bash
  # Safe: load kernel modules (ib_umad), clear reboot flags
  # Safe: set environment variables, configure paths
  # Not safe: nvidia-smi (drivers not loaded yet)
  # Not safe: any CUDA/NCCL operations
  # Not safe: systemctl start nvidia-fabricmanager (cinc handles this)

OnNodeConfigured: |
  #!/bin/bash
  # Safe: validate all GPU state after cinc has finished
  nvidia-smi --query-gpu=name,memory.total --format=csv   # verify all GPUs visible
  nvidia-smi topo -m                                       # verify NVLink topology
  nvidia-fabricmanager -n                                  # verify fabric manager
  /opt/amazon/efa/bin/fi_info -p efa                       # verify EFA interfaces
  # Safe: install monitoring agents, register services
```

---

## Handling heavy installs: enroot, Pyxis, NCCL

Some things you need on compute nodes take several minutes to install: enroot, Pyxis (the Slurm SPANK plugin for containers), NCCL libraries, nccl-tests binaries. Running these synchronously in OnNodeConfigured is a problem because OnNodeConfigured must complete before cfn-signal fires. If you take too long, the bootstrap times out.

The pattern that works: register a systemd service in OnNodeConfigured that runs the heavy installs after slurmd starts, then explicitly trigger it if slurmd is already running.

```ini
# /etc/systemd/system/post-slurmd-setup.service
[Unit]
Description=Post-slurmd heavy installs (enroot, Pyxis, NCCL)
After=slurmd.service
Wants=slurmd.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/post-slurmd-setup.sh
RemainAfterExit=yes
```

```bash
# end of OnNodeConfigured
systemctl enable post-slurmd-setup.service

# After=slurmd.service only fires on state transitions.
# slurmd is already running by the time OnNodeConfigured executes,
# so the dependency trigger never fires — start it explicitly.
if systemctl is-active --quiet slurmd; then
  systemctl start post-slurmd-setup.service &
fi
# The & is intentional: let cfn-signal fire on time while setup continues in background
```

The post-slurmd script can then take as long as it needs. It runs after cfn-signal, after the node is already registered with slurmctld, and it doesn't block job scheduling.

One more thing: NCCL test binaries are large and benefit from being built once and stored on shared storage. Build them to `/fsx/nccl-tests/bin/` the first time, then skip the build on subsequent node launches.

There is a subtle failure mode here that is easy to hit when you start baking things into your AMI. If enroot, Pyxis, or NCCL are already present in the AMI and your OnNodeConfigured script tries to install them again via apt, apt will pull in dependency packages like `linux-modules-extra` that were not needed before. Those packages trigger kernel upgrades that write `/var/run/reboot-required`. cinc finalize reads that file and reboots the node. slurmd never sends its heartbeat. clustermgtd marks the node unhealthy and replaces it. You get a replacement loop that looks like a random bootstrap failure.

The fix: once a package is baked into the AMI, remove the install step from OnNodeConfigured entirely. Use `dpkg -l` guards at most. And make sure `/etc/apt/apt.conf.d/99-no-reboot-required` is in the AMI so the flag gets cleared even if something slips through.

> ##### WARNING
>
> Do not modify `/opt/slurm/etc/plugstack.conf` or `/etc/slurm/plugstack.conf.d/` in OnNodeConfigured. cinc validates the Slurm configuration at startup and checks that every path referenced in plugstack.conf actually exists. If you add a Pyxis entry pointing to a `.so` file that does not exist yet, cinc aborts immediately. The node shuts down within 50 seconds, before cfn-signal ever fires, and clustermgtd marks it unhealthy. Pyxis SPANK plugin registration must happen at AMI build time, not at cluster launch time.
{: .block-warning }

---

## clustermgtd: the cluster's operations controller

clustermgtd is a Python daemon that runs on the HeadNode as root. It's the operational brain of a ParallelCluster, doing something no equivalent exists for in traditional on-premises Slurm installations.

On-premises, Slurm sees a node go DOWN and stops scheduling jobs to it. That's all. A human has to figure out what happened, fix it, and manually resume the node. The cluster waits.

In ParallelCluster, clustermgtd acts on DOWN nodes automatically. Its decision loop runs roughly every 60 seconds and considers multiple information sources simultaneously:

**EC2 health checks.** clustermgtd queries the EC2 instance status API for every compute node. If the underlying hardware has a hardware impairment, a network connectivity failure, or a system status check failure, clustermgtd knows about it independently of anything Slurm reports. This is how ParallelCluster catches host-level failures that Slurm alone would never detect.

**Slurm node state.** clustermgtd reads slurmctld's node state. A node that's been marked DOWN or DRAIN by slurmctld is a signal to act.

**Bootstrap state.** During the bootstrap window (before cfn-signal fires), clustermgtd watches for nodes that fail to come up within `ComputeNodeBootstrapTimeout`. If the signal doesn't arrive in time, it terminates the instance.

When clustermgtd decides a node is unhealthy, what happens depends on the node type:

For **static nodes** (`MinCount > 0`): clustermgtd reboots the instance. It doesn't terminate it, because static nodes should always be present. After reboot, the node goes through the full bootstrap sequence again and rejoins the cluster. Recovery takes 2 to 5 minutes.

For **dynamic nodes** (`MinCount = 0`): clustermgtd terminates the instance entirely. The capacity is released. When a job needs that slot again, a new instance is launched from scratch.

**On drain behavior.** This is the sharpest difference from on-premises Slurm. On a bare-metal cluster, draining a node (via `scontrol update node=X state=drain reason=...`) means the node finishes running its current jobs and then sits empty, waiting for a human to investigate and manually bring it back.

In ParallelCluster, a drained node that becomes idle is treated as an unhealthy node. clustermgtd detects the idle+drain state and either reboots it (static) or terminates it (dynamic). The cluster heals itself without human intervention. The trade-off is that if you drain a node to do manual maintenance, clustermgtd may reboot it before you're done. Use `scontrol update node=X state=drain reason=maintenance` and work quickly, or stop the fleet first.

---

## Slurm heartbeats and how DOWN actually happens

Every slurmd process sends a heartbeat to slurmctld at an interval defined by `SlurmdTimeout` (default 300 seconds, configurable). The heartbeat is a `REQUEST_NODE_REGISTRATION` RPC from the compute node to the HeadNode.

If slurmctld doesn't receive a heartbeat from a node within `SlurmdTimeout` seconds, slurmctld marks that node DOWN on its own. The compute node doesn't participate in this decision at all. slurmctld simply stops hearing from it and assumes the worst.

This has a practical implication: if your compute node is heavily loaded (saturated CPUs, network congestion, high memory pressure), the slurmd process can get delayed and miss its heartbeat window. The node will be marked DOWN even though it's technically still running and healthy. Under extreme GPU workloads this is rare but possible.

Once a node is marked DOWN by slurmctld, the event chain is:
1. slurmctld updates node state to DOWN with a reason
2. clustermgtd sees the DOWN state in its next polling cycle
3. For static nodes: clustermgtd triggers `/sbin/reboot` on the instance
4. The instance reboots, runs the full bootstrap again, re-registers with slurmctld
5. slurmctld updates node state to IDLE

The whole cycle (DOWN to IDLE again) takes about 3 to 7 minutes depending on how fast the instance boots.

---

## Capacity Block and large-scale distributed training

For large-scale distributed training (hundreds or thousands of GPUs), a single node failure is not just a minor inconvenience. Because distributed training jobs run across all nodes simultaneously, one node going down terminates the entire job. With 256 GPUs across 32 nodes and a 3-day training run, any unexpected node failure means losing everything since the last checkpoint.

This is why Capacity Block reservations are effectively required for serious distributed training. Spot instances can be reclaimed at any time. On-demand instances may not be available at the scale you need. A Capacity Block guarantees a fixed number of instances are available at a specific time for a specific duration.

The tradeoff: CB instances are more expensive than on-demand and must be reserved in advance. The CB slot is released on instance termination, so rollbacks and unexpected instance replacements during the reservation window cost you capacity you may not recover. Use `--rollback-on-failure false` and avoid unnecessary instance cycling during active reservations.

---

## The daemon stack you didn't know was running

```
HeadNode:
  slurmctld
    manages node state, job scheduling, conf hash distribution

  clustermgtd (pcluster daemon, root)
    polls EC2 health checks every ~60s
    polls slurmctld node states every ~60s
    reboots unhealthy static nodes
    terminates unhealthy dynamic nodes
    replaces nodes that fail bootstrap

ComputeNode:
  slurmd
    sends heartbeat to slurmctld every SlurmdTimeout seconds
    if heartbeat misses: slurmctld marks node DOWN, clustermgtd acts

cfn-hup (CloudFormation monitor, HeadNode)
  watches for stack updates
  on change: restarts slurmctld
  slurmctld restart regenerates slurm.conf, new conf hash
  compute nodes have old hash, slurmctld marks them DOWN
  clustermgtd sees DOWN, reboots all nodes
```

That last chain — cfn-hup triggering a conf hash cascade — happens automatically whenever you update the cluster stack. During development, add `DebugFlags=NO_CONF_HASH` to `CustomSlurmSettings` to prevent it.

> ##### DANGER
>
> Every CloudFormation stack update triggers this cascade by default. Without `NO_CONF_HASH`, any config change during active jobs will kill those jobs.
{: .block-danger }

---

## Timeout parameters worth knowing

| Parameter | Default | What triggers it |
|-----------|---------|-----------------|
| `ComputeNodeBootstrapTimeout` | 1800s | cfn-signal must arrive within this window |
| `SlurmdTimeout` | 300s | heartbeat timeout before node goes DOWN |
| `SuspendTime` | 300s | idle seconds before dynamic node terminates |

On GPU instances, set `ComputeNodeBootstrapTimeout: 3600`. The cinc bootstrap alone takes 15 to 25 minutes.

Set `SuspendTime: 36000` if you're using dynamic nodes on GPU instances. The default of 300 seconds will constantly terminate and re-bootstrap nodes.

> ##### DANGER
>
> `SuspendTime: 0` or `ScaledownIdletime: 0` on GPU instances triggers immediate termination when idle. If you're using a Capacity Block reservation, the slot is released and the next launch fails with `ReservationCapacityExceeded`.
{: .block-danger }

---

## Why standalone tests pass but cluster tests fail

A standalone EC2 instance with the same pcluster AMI doesn't run cinc. Chef cookbooks don't execute. So you write your script to handle everything cinc normally does: load modules, start services, configure drivers. Then you move the script into a real cluster and it breaks.

The reason: cinc has already done all of that. When your script tries to do it again, you get timing conflicts.

Specific examples from p6-b200 debugging:

Running `systemctl enable --now nvidia-fabricmanager` in OnNodeConfigured: cinc's `fabric_manager :configure` already handled this. The duplicate start creates a race condition during NVSwitch initialization.

Running `systemctl daemon-reload` in OnNodeConfigured: cinc has already called daemon-reload multiple times. An additional reload during GPU driver initialization has caused kernel panics on p6-b200.

Running `nvidia-smi` in OnNodeStart: cinc's `run_nvidiasmi` hasn't run yet. Your call races with driver loading and fails.

Before writing any OnNodeConfigured logic that touches GPU setup, check what cinc's cookbooks already do. The source is at `/etc/chef/cookbooks/aws-parallelcluster-*/` on any running pcluster node.

---

## Debugging reference

```bash
# HeadNode
tail -f /var/log/slurmctld.log              # node state changes, DOWN reasons
tail -f /var/log/slurm_elastic.log          # clustermgtd decisions
systemctl status cfn-hup                    # CloudFormation monitor running?

# ComputeNode
tail -f /var/log/slurmd.log                 # heartbeat, job launch
tail -f /var/log/parallelcluster/cinc.log   # cinc cookbook execution, errors
nvidia-smi                                  # GPU visible?
ls /var/run/reboot-required                 # pending reboot flag?

# Slurm state
sinfo -N                                    # node state per node
scontrol show node <nodename>               # full node details including reason
```

---

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 1: What Kind of Service Is ParallelCluster?](/pages/pcluster-series-0-what-is-pcluster-en/) | You are here: **Part 2: How ParallelCluster Works** | [Part 3: Why Your p6-b200 Nodes Keep Rebooting →](/pages/pcluster-series-2-reboots/)
{: .block-tip }
