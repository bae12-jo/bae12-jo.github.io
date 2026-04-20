---
title: "Distributed Training - Part 3: Why Your p6-b200 Nodes Keep Rebooting"
author: Bailey Sohyeon Cho
layout: post
lang: en
lang_peer: /pages/pcluster-series-2-reboots-ko/
---

# Why Your p6-b200 Compute Nodes Keep Rebooting on AWS ParallelCluster

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 2: How ParallelCluster Works](/pages/pcluster-series-1-internals/) | [Part 4: Building a Custom AMI →](/pages/pcluster-series-3-custom-ami/)

## Will the cluster roll back before it even comes up?

Yes, and on GPU instances like p6-b200 this happens often until you know to watch for it.

When you run `pcluster create-cluster`, CloudFormation starts a stack and waits for every resource to signal success. Compute nodes have to complete cloud-init, run cinc (the Chef bootstrap), install drivers, and send a `cfn-signal`, all within `ComputeNodeBootstrapTimeout`. On p6-b200, that bootstrap alone takes 15 to 25 minutes. The default timeout is 30 minutes. If the node doesn't signal in time, CloudFormation marks it failed and rolls back the entire stack.

The rollback destroys everything: the HeadNode, the FSx association, the networking. You're back to zero and have to recreate it all from scratch.

Two settings matter here:

```yaml
# cluster config
DevSettings:
  Timeouts:
    ComputeNodeBootstrapTimeout: 3600
```

```bash
# at create time
pcluster create-cluster \
  --cluster-configuration config.yaml \
  --rollback-on-failure false
```

The timeout increase is straightforward, give the bootstrap enough room. The `--rollback-on-failure false` flag is more important: it keeps the stack alive when a node fails, so you can SSH or SSM in and actually see what went wrong. Without it, every failed attempt wipes the cluster and you're debugging blind.

> ##### DANGER
>
> On Capacity Block instances, a rollback is especially costly. The CB slot gets released when the stack tears down, and you may not get it back. If you're iterating on a p6-b200 setup, always use `--rollback-on-failure false`.
{: .block-danger }

If a node fails during iteration, don't delete the cluster and recreate it. Use `pcluster update-cluster` to push config changes, or fix things directly on the stuck node via SSM. Recreating means bootstrapping the HeadNode again, another 10 to 15 minutes gone.

---

You've provisioned a p6-b200.48xlarge cluster, doubled the timeouts, disabled health checks, and the nodes still die. Some reboot at exactly 68 seconds. Others make it to 7 minutes then vanish. A few boot completely then restart in a loop. The obvious things didn't work.

There are four distinct root causes. Each appears at a different time, produces a different error, and looks like something else.

---

## Cause 1: Node dies at ~68 seconds — `ib_umad` missing

**Symptom**: The node boots, kernel loads, systemd starts services. At 68 seconds the instance shuts down. CloudFormation reports failure during `nvidia_config`. No useful logs on the node.

Increasing `ComputeNodeBootstrapTimeout` doesn't help. `systemctl disable nvidia-fabricmanager` doesn't help. `nvidia-smi` works fine on a standalone instance.

**What's actually happening**: During cinc's `fabric_manager :configure` phase, `nvidia-fabricmanager` starts. It has an internal precheck that polls `/sys/class/infiniband` for 60 seconds looking for IB devices. Without the `ib_umad` kernel module loaded, no devices appear. After 60 seconds, fabricmanager concludes it's running on a "Pre-NVL5 system" — and on p6-b200 with GB100 GPUs, this triggers a kernel panic.

```
[   68.245821] No devices found in /sys/class/infiniband within 60 seconds
[   68.452104] Detected Pre-NVL5 system, initializing without NVSwitch fabric support
[   68.623018] NVRM: _knvlinkCheckFabricCliqueId: GPU 0 failed to get fabric clique Id
[   68.901234] Kernel panic - not syncing: GPU fabric initialization failed
```

The 68-second timing looks like a timeout. It is — but it's fabricmanager's internal precheck threshold (60s poll + ~8s overhead), not the bootstrap timeout.

`ib_umad` has to be loaded *before* cinc starts. `modprobe ib_umad` in OnNodeStart is too late — cinc has already launched fabricmanager by then. The module needs to be in `/etc/modules` so it loads at boot.

> ##### TIP
>
> The fix goes in the AMI, not in a hook script. Any script-based fix runs after cinc has already tried and failed to start fabricmanager.
{: .block-tip }

```bash
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils
modprobe ib_umad
echo "ib_umad" >> /etc/modules
```

---

## Cause 2: Node reboots ~7 minutes after cfn-signal success

**Symptom**: The node launches, cfn-signal reports success, Slurm marks it IDLE. You submit a job. Seven minutes later the node is gone. No error in the job log. It comes back up and boots again.

Masking `unattended-upgrades` doesn't help. Removing `needrestart` doesn't help. Adding a hook to OnNodeConfigured to clear reboot flags fires too late.

**What's actually happening**: During cinc's init phase, it installs packages — including `linux-modules-extra-$(uname -r)`. On our cluster this triggered a kernel minor version upgrade from `6.8.0-1050-aws` to `6.8.0-1052-aws`. When that happens, apt's post-install hooks create `/var/run/reboot-required`. The file is created during cinc init, but cinc finalize runs *after* cfn-signal. In finalize, cinc explicitly checks for this file and calls `reboot`. By the time the node is IDLE and running jobs, finalize hasn't fired yet — it fires 5–7 minutes later.

```
cinc finalize:
  [INFO] package[linux-modules-extra-6.8.0-1052-aws]   ← creates reboot flag
  [INFO] /var/run/reboot-required: exists
  [INFO] Executing: /sbin/reboot                       ← 7 minutes after cfn-signal
```

> ##### WARNING
>
> `needrestart` removal and `unattended-upgrades` masking don't touch this. cinc itself installs packages and creates the flag. The only way to stop it is a dpkg post-invoke hook that deletes the file immediately after any package install.
{: .block-warning }

```bash
cat > /etc/apt/apt.conf.d/99-no-reboot-required <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
```

This runs after every package install, including ones cinc triggers, and deletes the flag before cinc finalize can read it.

---

## Cause 3: cinc fails before cfn-signal — fabricmanager masked in AMI

**Symptom**: Node fails during cinc, around 3 minutes in, before cfn-signal ever fires. The cinc log shows: `service[nvidia-fabricmanager] had an error: expected '0' but got '1'`.

**What's actually happening**: `systemctl mask` creates a symlink pointing the unit file at `/dev/null`. When cinc's `fabric_manager :configure` recipe calls `systemctl start`, a masked service always returns exit code 1. cinc sees the error, marks the recipe FATAL, and the bootstrap fails.

| state | cinc `start` behavior |
|---|---|
| `enabled` | no-op if already running |
| `disabled` | attempts start |
| `masked` | always returns exit code 1 |

> ##### DANGER
>
> There is no workaround for a masked service. AMI must have fabricmanager in `enabled` or `disabled` state at bake time. `masked` means every bootstrap attempt fails.
{: .block-danger }

```bash
# correct
systemctl enable nvidia-fabricmanager

# do not do this in an AMI
systemctl mask nvidia-fabricmanager
```

---

## Cause 4: Conf hash reboot loop — cfn-hup

**Symptom**: Cluster is stable, jobs running. You update the CloudFormation stack. Nodes start going DOWN one by one. slurmctld logs show: `appears to have a different slurm.conf hash`. Each node recovers to IDLE, then goes DOWN again minutes later. The loop doesn't stop.

Restarting slurmctld manually doesn't help. The hashes keep drifting.

**What's actually happening**: When you update the CF stack, cfn-hup (running on HeadNode) detects the change and restarts slurmctld. Each restart regenerates slurm.conf and produces a new hash. Compute nodes have the old hash. slurmctld marks them DOWN. clustermgtd sees DOWN and triggers `/sbin/reboot`. Nodes reboot, sync the new hash, go IDLE — then cfn-hup fires again.

```
T+0s    CloudFormation stack update
T+5s    cfn-hup fires → slurmctld restarts
T+10s   slurmctld: new conf, new hash HASH_V2
T+20s   compute node still has HASH_V1 → mismatch
T+25s   slurmctld marks node DOWN
T+30s   clustermgtd → /sbin/reboot
T+90s   node reboots, gets HASH_V2, goes IDLE
T+95s   cfn-hup fires again → repeat
```

> ##### WARNING
>
> This runs indefinitely and silently kills long-running jobs. Any stack update while jobs are running will interrupt them.
{: .block-warning }

```yaml
# cluster config
CustomSlurmSettings:
  - "DebugFlags=NO_CONF_HASH"
```

---

## Why standalone EC2 testing doesn't surface any of this

None of these causes exist on a standalone instance. cinc doesn't run. There's no finalize phase checking for reboot flags. No cfn-hup watching the stack. No clustermgtd rebooting DOWN nodes. All four failure modes require ParallelCluster's orchestration layer to trigger.

If your setup works standalone and breaks in the cluster, that gap is where to look.

---

## Quick diagnosis

**Node dies at ~68s?** → `dmesg | grep -i "Pre-NVL5\|kbifCacheVFInfo"` — if you see it, `ib_umad` wasn't loaded before cinc started. Fix: bake it into the AMI via `/etc/modules`.

**Node reboots 5–7 min after cfn-signal success?** → `/var/log/parallelcluster/cinc.log | grep reboot` — if cinc finalize is calling reboot, you have a `reboot-required` flag. Fix: dpkg post-invoke hook in AMI.

**Node fails ~3 min in, before cfn-signal?** → cinc.log for `expected '0' but got '1'` on fabricmanager — service is masked in the AMI. Fix: `systemctl enable`, not `mask`.

**Nodes cycling UP → DOWN repeatedly after a stack update?** → slurmctld.log for `different slurm.conf hash` — cfn-hup conf hash cascade. Fix: `DebugFlags=NO_CONF_HASH`.

---

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 2: How ParallelCluster Works](/pages/pcluster-series-1-internals/) | You are here: **Part 3: Why Your p6-b200 Nodes Keep Rebooting** | [Part 4: Building a Custom AMI →](/pages/pcluster-series-3-custom-ami/)
{: .block-tip }
