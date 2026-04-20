---
title: "Distributed Training - Part 1: How AWS ParallelCluster Works Under the Hood"
author: Bailey Sohyeon Cho
layout: post
lang: en
parent: "Setting Up a GPU Cluster"
---

# How AWS ParallelCluster Actually Works Under the Hood

> **Series**: Distributed Training on AWS ParallelCluster
> **Part 1 of 3** — [Part 2: Why Your p6-b200 Nodes Keep Rebooting →](/pages/pcluster-series-2-reboots/)

When you run `pcluster create-cluster`, something remarkable happens. Most ML engineers think of ParallelCluster as a simple wrapper around CloudFormation and EC2. But the reality is far more nuanced. There's an entire orchestration layer — Chef cookbooks, custom daemons, cloud-init phases, and timing-critical operations — that runs silently in the background. Understanding this matters because **the same AMI and scripts behave completely differently on a standalone EC2 instance than they do inside a ParallelCluster**.

This post walks through that hidden machinery. I'll show you what actually happens when you create a cluster, why certain configurations fail without explanation, and why your GPU setup might work locally but fail in production.

---

## The Creation Sequence: From `pcluster create-cluster` to Running `slurmd`

Here's the step-by-step choreography that happens when ParallelCluster boots a node:

```
pcluster create-cluster
    ↓
CloudFormation creates stack (HeadNode, ComputeNodes, VPC, security groups)
    ↓
EC2 launches instance with pcluster-specific AMI
    ↓
cloud-init phase 1: Runs UserData script
    ↓
cloud-init phase 2: Runs cinc (Chef) bootstrap
    ↓
cinc executes pcluster cookbooks (nvidia_config.rb, slurm_install.rb, efa_driver.rb, etc.)
    ↓
Reboot (if /var/run/reboot-required detected)
    ↓
CustomActions run (OnNodeConfigured phase)
    ↓
cfn-signal sends completion signal to CloudFormation
    ↓
slurmd starts on ComputeNodes
slurmctld starts on HeadNode
    ↓
clustermgtd (pcluster daemon) detects nodes and marks them as idle
```

Each of these steps is critical. If any step fails or hangs, the entire cluster creation hangs indefinitely.

---

## The cinc (Chef) Bootstrap: Your Real Configuration Engine

ParallelCluster doesn't use arbitrary scripts for system configuration — it uses **cinc** (a Chef Infra Client fork) to run orchestrated cookbooks. This happens automatically after cloud-init and before CustomActions.

Here's what cinc does on each node:

### nvidia_config.rb Cookbook

This is the heavy hitter for GPU nodes. It runs in strict order:

```ruby
gdrcopy :configure
  # Loads the gdrdrv kernel module
  # Enables GPU Direct RDMA (required for NVLink, EFA, fabric manager)

fabric_manager :configure
  # Starts nvidia-fabricmanager
  # Critical: If already running → no-op ✅
  # If masked (systemctl mask) → ALWAYS FAILS ❌

run_nvidiasmi
  # Validates GPU discovery
  # If this fails, GPUs aren't visible to Slurm

efa_driver :setup
  # Installs Elastic Fabric Adapter drivers

slurm_install :configure
  # Installs Slurm, generates slurm.conf
```

Then, after all cookbooks complete:

```
cinc finalize phase:
  1. Check /var/run/reboot-required
     → If file exists: reboot immediately
  2. After reboot: Mount FSx Lustre
```

> ##### WARNING
>
> If your custom AMI installs anything that sets `/var/run/reboot-required`, cinc finalize will reboot your node and your CustomActions won't run. This is the most common source of phantom reboots on GPU clusters.
{: .block-warning }

---

## CustomActions Timing: The Critical Detail

ParallelCluster has two CustomActions entry points, and **the timing is not intuitive**:

```
cloud-init (UserData) finishes
    ↓
cinc (Chef) starts
    ↓
OnNodeStart triggers  ← RUNS HERE (BEFORE cinc finishes!)
    ↓
cinc continues and finishes
    ↓
cfn-signal checkpoint
    ↓
OnNodeConfigured triggers  ← RUNS HERE (AFTER cinc finishes)
    ↓
slurmd starts
```

> ##### TIP
>
> If your OnNodeStart script tries to run `nvidia-smi`, it will fail — GDRcopy, fabric_manager, and NVIDIA drivers haven't been loaded yet. Put all GPU validation in **OnNodeConfigured**, not OnNodeStart.
{: .block-tip }

Real example from p6-b200 setup:

```yaml
# cluster-config-p6b200.yaml
OnNodeStart: |
  #!/bin/bash
  # ❌ DON'T do GPU validation here — nvidia-smi will hang or fail

OnNodeConfigured: |
  #!/bin/bash
  # ✅ DO validate GPU state here
  nvidia-smi
  nvidia-fabricmanager -n
```

---

## The Slurm Management Stack: A Hidden Orchestra

ParallelCluster doesn't just install Slurm — it creates an entire daemon ecosystem:

```
HeadNode:
  slurmctld (Slurm controller)
    ↓ publishes node state

  clustermgtd (pcluster daemon, runs as root)
    ↓ monitors slurmctld
    ↓ detects nodes marked DOWN
    ↓ triggers RebootProgram=/sbin/reboot (static nodes)
    ↓ or terminates (dynamic nodes)

ComputeNode:
  slurmd (Slurm node agent)
    ↓ sends heartbeat to slurmctld every SlurmdTimeout seconds
    ↓ if heartbeat fails: marked DOWN

cfn-hup (CloudFormation monitor)
  ↓ watches for stack updates
  ↓ on change: restarts slurmctld
  ↓ slurmctld reload regenerates conf hash
  ↓ all nodes see conf hash mismatch
  ↓ Slurm marks all nodes DOWN
  ↓ clustermgtd detects DOWN → reboots all nodes
```

> ##### DANGER
>
> The cfn-hup loop above is a **node replacement cascade**. It happens automatically whenever you update a cluster. To prevent it, add `DebugFlags: NO_CONF_HASH` to your CustomSlurmSettings during development.
{: .block-danger }

---

## Static vs Dynamic Nodes: The Scaling Model

### Static Nodes (MinCount > 0)

```
State: running (always on)
If marked DOWN:
  → clustermgtd triggers reboot
  → node comes back in 2-5 minutes
```

### Dynamic Nodes (MinCount = 0)

```
State: running (only when jobs are queued)
If idle for SuspendTime seconds:
  → instance terminates
On next job:
  → new instance launched
  → cloud-init + cinc bootstrap (~8-15 minutes)
```

> ##### TIP
>
> For GPU clusters like p6-b200, **static nodes are almost always better**. Dynamic node launch takes 8-15 minutes including cloud-init + cinc. Set `MinCount: 1` and `SuspendTime: 36000` to keep nodes warm.
{: .block-tip }

---

## Timeout Parameters: The Invisible Tuning Knobs

| Parameter | Default | What It Does | p6-b200 Recommended |
|-----------|---------|--------------|-------------------|
| `SlurmdTimeout` | 300s | Heartbeat timeout before node goes DOWN | 300s |
| `ComputeNodeBootstrapTimeout` | 1800s | Max time for cloud-init + cinc | 3600s |
| `KillWait` | 30s | Grace period after job cancellation | 60s |
| `SuspendTime` | 300s | Idle time before dynamic node terminates | 36000s |

> ##### DANGER
>
> Never set `SuspendTime: 0` or `ScaledownIdletime: 0` on p6-b200. This triggers immediate suspension of idle static nodes, which causes `ReservationCapacityExceeded` on restart and a DOWN loop.
{: .block-danger }

---

## Why Standalone EC2 Tests Are Misleading

```
Standalone EC2 Instance (pcluster AMI)
  ↓ cinc is NOT installed
  ↓ No Chef cookbooks run
  ↓ nvidia drivers NOT loaded by cinc
  ↓ fabric_manager startup timing is different
  ↓ No slurmd context

Inside ParallelCluster
  ↓ cinc bootstraps and runs nvidia_config.rb
  ↓ fabric_manager starts during cinc
  ↓ Slurm installed before CustomActions
  ↓ Your scripts run with full slurmd context
```

> ##### WARNING
>
> Standalone tests pass, cluster tests fail — this is the pattern. Fabric manager timing is different. GDRcopy loads at a different point. If your script validates fabric_manager in OnNodeStart, it succeeds standalone but fails in ParallelCluster.
{: .block-warning }

---

## Debugging in Production

```bash
# On HeadNode
tail -f /var/log/slurmctld.log         # Node state changes
tail -f /var/log/slurm_elastic.log     # clustermgtd decisions
systemctl status cfn-hup               # CloudFormation monitor running?

# On ComputeNode
tail -f /var/log/slurmd.log            # Heartbeat, job launch
nvidia-smi                             # GPU visible?
ls -la /var/run/reboot-required        # Pending reboot?

# Slurm state
sinfo                                  # Node state overview
scontrol show nodes                    # Detailed node config
```

---

## Key Lessons

1. **OnNodeStart runs before cinc finishes** — no GPU validation here
2. **Never change pcluster-managed EC2 tags** — triggers node replacement
3. **`/var/run/reboot-required` = silent reboot** — cinc finalize will catch it
4. **Fabric manager is binary** — running or not, no graceful degradation
5. **`cfn-hup` is a footgun** — every CloudFormation update triggers conf hash cascade
6. **Static nodes need `SuspendTime >> 0`** — zero is a fast path to DOWN loops

---

> **Series**: Distributed Training on AWS ParallelCluster
>
> ← You are here: **Part 1: How ParallelCluster Works**
> [Part 2: Why Your p6-b200 Nodes Keep Rebooting →](/pages/pcluster-series-2-reboots/)
{: .block-tip }
