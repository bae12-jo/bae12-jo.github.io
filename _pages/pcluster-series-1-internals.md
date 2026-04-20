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

Phase 2 runs the cinc bootstrap. This is where the real work happens. ParallelCluster embeds a cinc invocation in cloud-init that pulls down the pcluster cookbooks and runs them. There's no explicit trigger you set up — it happens automatically because it's baked into the pcluster AMI's cloud-init configuration.

---

## cinc: why it runs and what it does

cinc is a fork of Chef Infra Client, the configuration management tool. ParallelCluster chose Chef/cinc because GPU cluster setup involves dozens of interdependent configuration steps that need to run in a precise order. A shell script would be brittle. cinc's declarative cookbook model lets pcluster define the desired state and have it enforced idempotently on every node.

You don't invoke cinc. You don't configure it. It runs because the pcluster AMI has it installed and cloud-init calls it. By the time your OnNodeConfigured script starts, cinc has already finished its work.

On GPU nodes, cinc runs `nvidia_config.rb` — the most consequential cookbook for our purposes:

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

## OnNodeStart vs OnNodeConfigured: the timing matters

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

OnNodeStart executes while cinc is still in the middle of setting up the system. GPU drivers haven't been loaded. GDRcopy hasn't configured. nvidia-fabricmanager hasn't started. If you put `nvidia-smi` in OnNodeStart, it will fail or hang.

OnNodeConfigured runs after cinc has finished everything. This is where GPU validation belongs.

```yaml
# correct placement
OnNodeStart: |
  #!/bin/bash
  # safe: kernel module loading, reboot flag cleanup
  # not safe: nvidia-smi, anything that requires cinc to have run first

OnNodeConfigured: |
  #!/bin/bash
  nvidia-smi              # cinc has finished, GPUs are visible
  nvidia-fabricmanager -n # fabricmanager is running
```

---

## After=slurmd.service: how it works and where it breaks

A common pattern for running post-bootstrap monitoring setup is to create a systemd service with `After=slurmd.service`:

```ini
[Unit]
Description=Post-bootstrap monitoring setup
After=slurmd.service
Wants=slurmd.service
```

This works when slurmd starts after the service unit is enabled — it triggers on slurmd's state transition from inactive to active.

The problem: by the time OnNodeConfigured runs, slurmd has already started. systemd's `After=` dependency only fires on state transitions. If slurmd is already running when the service is registered, the `After=slurmd.service` trigger never fires.

The fix is to explicitly start the service at the end of OnNodeConfigured, after enabling it:

```bash
# OnNodeConfigured (setup-compute-node.sh)
systemctl enable post-slurmd-monitoring.service

# Explicitly trigger if slurmd is already running
if systemctl is-active --quiet slurmd; then
  systemctl start post-slurmd-monitoring.service &
fi
```

The `&` is intentional. The post-bootstrap setup (pulling Docker images, installing packages, building binaries) takes several minutes. Running it in the background lets cfn-signal fire on time and slurmd register with slurmctld, while the monitoring setup continues in parallel.

---

## The standalone testing trap

Testing your OnNodeConfigured scripts on a standalone EC2 instance (with the same pcluster AMI) seems like a reasonable way to iterate quickly. It produces misleading results.

On a standalone instance, cinc doesn't run. Chef cookbooks don't execute. So you write your script to handle everything cinc normally does: load modules, start services, configure drivers. Then you move the script into a real cluster and it breaks.

The reason: cinc has already done all of that. When your script tries to do it again, you get timing conflicts. The failure modes look random but they're not.

Specific examples from p6-b200 debugging:

- Running `systemctl enable --now nvidia-fabricmanager` in OnNodeConfigured: cinc's `fabric_manager :configure` already handled this. The duplicate start creates a race condition during NVSwitch initialization.
- Running `systemctl daemon-reload` in OnNodeConfigured: cinc has already called daemon-reload multiple times. An additional reload during GPU driver initialization has caused kernel panics on p6-b200.
- Running `nvidia-smi` in OnNodeStart: cinc's `run_nvidiasmi` hasn't run yet. Your call races with driver loading and fails.

Before writing any OnNodeConfigured logic that touches GPU setup, check what cinc's cookbooks already do. The source is at `/etc/chef/cookbooks/aws-parallelcluster-*/` on any running pcluster node.

The right question when writing a hook script isn't "what do I need to set up?" It's "what does cinc not handle, and what can I do without conflicting with what cinc does?"

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

**Static nodes** (`MinCount > 0`) are always running. When they go DOWN, clustermgtd reboots them and they recover in 2–5 minutes. For p6-b200 with Capacity Block reservations, static is almost always the right choice. Dynamic node launch takes 8–15 minutes and releasing a CB slot on termination means you may not get it back.

**Dynamic nodes** (`MinCount = 0`) only exist when jobs are queued. After `SuspendTime` seconds idle, the instance terminates. The next job triggers a full cloud-init + cinc bootstrap from scratch.

Set `SuspendTime: 36000` on GPU clusters. The default of 300 seconds will constantly terminate and re-bootstrap nodes.

> ##### DANGER
>
> `SuspendTime: 0` or `ScaledownIdletime: 0` on p6-b200 triggers immediate termination when idle. The CB slot is released. The next launch fails with `ReservationCapacityExceeded`. Don't do it.
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

## Debugging reference

```bash
# HeadNode
tail -f /var/log/slurmctld.log         # node state changes, DOWN reasons
tail -f /var/log/slurm_elastic.log     # clustermgtd decisions
systemctl status cfn-hup               # CloudFormation monitor running?

# ComputeNode
tail -f /var/log/slurmd.log            # heartbeat, job launch
tail -f /var/log/parallelcluster/cinc.log  # cinc cookbook execution, errors
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
