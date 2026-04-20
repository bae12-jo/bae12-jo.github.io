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

When you run `pcluster create-cluster`, something happens that most ML engineers don't expect. The same AMI and the same scripts behave completely differently on a standalone EC2 instance than they do inside a ParallelCluster. This post explains why.

---

## What actually happens from create-cluster to slurmd

```
pcluster create-cluster
    ↓
CloudFormation creates the stack (HeadNode, ComputeNodes, VPC, security groups)
    ↓
EC2 launches instance with pcluster AMI
    ↓
cloud-init phase 1: runs UserData
    ↓
cloud-init phase 2: runs cinc (Chef) bootstrap
    ↓
cinc executes pcluster cookbooks (nvidia_config.rb, slurm_install.rb, efa_driver.rb, ...)
    ↓
reboot (if /var/run/reboot-required is present)
    ↓
OnNodeConfigured runs
    ↓
cfn-signal sent to CloudFormation
    ↓
slurmd starts on compute nodes / slurmctld on HeadNode
    ↓
clustermgtd detects nodes and marks them idle
```

If any step fails or hangs, the whole cluster creation stalls.

---

## cinc: the actual configuration engine

ParallelCluster doesn't use arbitrary scripts to configure nodes — it uses **cinc** (a Chef Infra Client fork) that runs a fixed set of cookbooks. This happens automatically after cloud-init, before your CustomActions get a turn.

On GPU nodes, the relevant cookbook is `nvidia_config.rb`, which runs in strict order:

```ruby
gdrcopy :configure
  # loads gdrdrv kernel module
  # enables GPU Direct RDMA (needed for NVLink, EFA, fabric manager)

fabric_manager :configure
  # starts nvidia-fabricmanager
  # if already running → no-op
  # if masked (systemctl mask) → always fails with exit code 1

run_nvidiasmi
  # validates GPU discovery
  # if this fails, GPUs won't be visible to Slurm

efa_driver :setup
slurm_install :configure
```

After all cookbooks finish, cinc runs a finalize phase:

```
cinc finalize:
  1. check /var/run/reboot-required
     → if the file exists: reboot
  2. mount FSx Lustre
```

> ##### WARNING
>
> If anything your custom AMI installs writes `/var/run/reboot-required`, cinc finalize will reboot the node before your OnNodeConfigured script runs. This is the most common source of phantom reboots on GPU clusters — and it looks like a timeout, not a reboot trigger.
{: .block-warning }

---

## OnNodeStart vs OnNodeConfigured: the timing is not obvious

```
cloud-init (UserData) finishes
    ↓
cinc starts
    ↓
OnNodeStart runs  ← BEFORE cinc finishes
    ↓
cinc continues and finishes
    ↓
cfn-signal checkpoint
    ↓
OnNodeConfigured runs  ← AFTER cinc finishes
    ↓
slurmd starts
```

OnNodeStart runs *before* cinc has loaded GPU drivers, GDRcopy, or fabric manager. If you put `nvidia-smi` in OnNodeStart, it will fail or hang. GPU validation belongs in OnNodeConfigured.

```yaml
# correct placement
OnNodeStart: |
  #!/bin/bash
  # kernel module prep, reboot flag cleanup — no nvidia-smi here

OnNodeConfigured: |
  #!/bin/bash
  nvidia-smi           # safe here — cinc has finished
  nvidia-fabricmanager -n
```

---

## The daemon stack you didn't know was running

ParallelCluster doesn't just install Slurm. It creates a set of daemons that interact with each other in ways that cause surprising behavior:

```
HeadNode:
  slurmctld
    ↓ publishes node state

  clustermgtd (pcluster daemon, runs as root)
    ↓ watches slurmctld for DOWN nodes
    ↓ triggers /sbin/reboot on static nodes that go DOWN
    ↓ terminates dynamic nodes

ComputeNode:
  slurmd
    ↓ sends heartbeat to slurmctld every SlurmdTimeout seconds
    ↓ if heartbeat fails: marked DOWN by slurmctld

cfn-hup (CloudFormation monitor, HeadNode)
  ↓ watches for stack updates
  ↓ on change: restarts slurmctld
  ↓ slurmctld restart regenerates slurm.conf, new conf hash
  ↓ compute nodes have old hash → slurmctld marks them DOWN
  ↓ clustermgtd sees DOWN → reboots all nodes
```

That last chain is a cascade that happens automatically whenever you update the cluster. During development, add `DebugFlags=NO_CONF_HASH` to `CustomSlurmSettings` to prevent it.

> ##### DANGER
>
> Every CloudFormation stack update triggers this cascade by default. Without `NO_CONF_HASH`, any config change during active jobs will kill those jobs.
{: .block-danger }

---

## Static vs dynamic nodes

**Static nodes** (`MinCount > 0`) are always running. When they go DOWN, clustermgtd reboots them — they recover in 2–5 minutes. For p6-b200 with Capacity Block reservations, static is almost always the right choice. Dynamic node launch takes 8–15 minutes and loses your CB slot on termination.

**Dynamic nodes** (`MinCount = 0`) only exist when jobs are queued. After `SuspendTime` seconds idle, the instance terminates. The next job triggers a full cloud-init + cinc bootstrap from scratch.

Set `SuspendTime: 36000` on GPU clusters. The default of 300 seconds will constantly terminate and re-bootstrap nodes, and if you have a CB reservation, you may not get the slot back.

> ##### DANGER
>
> `SuspendTime: 0` or `ScaledownIdletime: 0` on p6-b200 = immediate slot release on idle. The node terminates, the CB slot is gone, and the next launch fails with `ReservationCapacityExceeded`. Don't do it.
{: .block-danger }

---

## Timeout parameters worth knowing

| Parameter | Default | What triggers it |
|-----------|---------|-----------------|
| `ComputeNodeBootstrapTimeout` | 1800s | cfn-signal must arrive within this window |
| `SlurmdTimeout` | 300s | heartbeat timeout before node goes DOWN |
| `SuspendTime` | 300s | idle seconds before dynamic node terminates |

On p6-b200, set `ComputeNodeBootstrapTimeout: 3600`. The cinc bootstrap alone takes 15–25 minutes.

---

## Why standalone tests pass but cluster tests fail

A standalone EC2 instance (even with the same pcluster AMI) doesn't run cinc. Chef cookbooks don't execute. nvidia drivers aren't loaded by cinc. There's no slurmd heartbeat, no clustermgtd watching for DOWN states, no cfn-hup restarting services.

Every failure mode in Part 3 requires ParallelCluster's internal orchestration to trigger. If your script works on a standalone instance and breaks in the cluster, look at what cinc does in between.

---

## Debugging reference

```bash
# HeadNode
tail -f /var/log/slurmctld.log         # node state changes, DOWN reasons
tail -f /var/log/slurm_elastic.log     # clustermgtd decisions
systemctl status cfn-hup               # CloudFormation monitor running?

# ComputeNode
tail -f /var/log/slurmd.log            # heartbeat, job launch
nvidia-smi                             # GPU visible?
ls /var/run/reboot-required            # pending reboot flag?

# Slurm state
sinfo -N                               # node state per node
scontrol show node <nodename>          # full node details including reason
```

---

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 1: What Kind of Service Is ParallelCluster?](/pages/pcluster-series-0-what-is-pcluster-en/) | You are here: **Part 2: How ParallelCluster Works** | [Part 3: Why Your p6-b200 Nodes Keep Rebooting →](/pages/pcluster-series-2-reboots/)
{: .block-tip }
