---
title: "Distributed Training - Part 2: Why Your p6-b200 Nodes Keep Rebooting"
author: Bailey Sohyeon Cho
layout: post
lang: en
parent: "Setting Up a GPU Cluster"
---

# Why Your p6-b200 Compute Nodes Keep Rebooting on AWS ParallelCluster

> **Series**: Distributed Training on AWS ParallelCluster
>
> [← Part 1: How ParallelCluster Works](/pages/pcluster-series-1-internals/) | [Part 3: Building a Custom AMI →](/pages/pcluster-series-3-custom-ami/)

You've provisioned a p6-b200.48xlarge cluster on AWS ParallelCluster, doubled your timeouts, disabled health checks, and your nodes still die. Some reboot at exactly 68 seconds. Others make it to 7 minutes then vanish. A few boot completely then restart in a loop. You're here because the obvious things didn't work.

This post walks through the four root causes I found debugging a production p6-b200 cluster — each one masquerading as something else, each one hiding behind a different error message at a different point in the bootstrap sequence.

---

## Cause 1: Node Dies at ~68 Seconds — `ib_umad` Missing

**Symptom**: Node boots, kernel loads, systemd starts services. At exactly 68 seconds, the instance shuts down. CloudFormation reports failure during `nvidia_config`. No useful logs.

**What we tried that didn't work**:
- Increasing `ComputeNodeBootstrapTimeout` to 3600s — node still dies at 68s
- `systemctl disable nvidia-fabricmanager` — no effect
- Running `nvidia-smi` standalone — works perfectly

**The actual cause**: The `nvidia-fabricmanager` service starts during cinc's `fabric_manager :configure` phase. It has an internal precheck that polls `/sys/class/infiniband` for 60 seconds looking for IB devices. Without the `ib_umad` kernel module loaded, no devices appear. After 60 seconds of silence, fabricmanager detects a "Pre-NVL5 system" — meaning it thinks it's running on hardware older than NVLink 5. On a p6-b200 with GB100 GPUs, this triggers a kernel panic.

```
[   68.245821] nvidia-fabricmanager-start.sh: No devices found in /sys/class/infiniband within 60 seconds
[   68.452104] Detected Pre-NVL5 system, initializing without NVSwitch fabric support
[   68.623018] NVRM: _knvlinkCheckFabricCliqueId: GPU 0 failed to get fabric clique Id: 0x55
[   68.901234] Kernel panic - not syncing: GPU fabric initialization failed
```

The 68-second timing is so precise it looks like a timeout — but it's actually the fabricmanager precheck threshold (60s poll + ~8s overhead).

> ##### TIP
>
> `ib_umad` must be **loaded before cinc starts**. `modprobe ib_umad` in OnNodeStart is too late — cinc has already started fabric_manager. The module must be baked into the AMI via `/etc/modules`.
{: .block-tip }

**The fix**:

```bash
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils
modprobe ib_umad
echo "ib_umad" >> /etc/modules   # ← persists across reboots
```

**Verification**: `lsmod | grep ib_umad` should show the module loaded at boot.

---

## Cause 2: Node Reboots at ~7 Minutes — The `reboot-required` Trap

**Symptom**: Node launches, cfn-signal reports success, Slurm marks the node IDLE. You submit a job. Seven minutes later — gone. No error in the job log. The node comes back up and boots again.

**What we tried that didn't work**:
- Masking `unattended-upgrades` — doesn't prevent the reboot
- Removing `needrestart` — doesn't help
- Adding `OnNodeConfigured` hooks to clear reboot flags — fires too late

**The actual cause**: During cinc's init phase, it installs packages — including `linux-modules-extra-$(uname -r)`. On our cluster, this triggered a kernel minor version upgrade from `6.8.0-1050-aws` to `6.8.0-1052-aws`. When this happens, apt's post-install hooks create `/var/run/reboot-required`. The file is created during cinc init, but cinc finalize runs **after cfn-signal**. In finalize, cinc explicitly checks for this file and calls `reboot`. By the time the node is UP and running jobs, finalize hasn't fired yet.

```
cinc finalize log:
  [INFO] Running: package[linux-modules-extra-6.8.0-1052-aws]   ← triggers reboot flag
  [INFO] /var/run/reboot-required: exists
  [INFO] Executing: /sbin/reboot   ← 7 minutes after cfn-signal
```

> ##### WARNING
>
> `needrestart` removal and `unattended-upgrades` masking are not enough. **cinc itself** installs packages and creates the reboot flag — the only reliable fix is a dpkg post-invoke hook that deletes the file immediately after any package install.
{: .block-warning }

**The fix**:

```bash
cat > /etc/apt/apt.conf.d/99-no-reboot-required <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
```

This runs after every package install (including during cinc) and immediately deletes the reboot marker.

**Why the 7-minute timing**: cfn-signal fires when slurmd registers. cinc finalize runs afterward, typically 5–7 minutes later on p6-b200 due to the FSx mount and additional config steps.

---

## Cause 3: cinc `:start` Always Fails — Fabricmanager Masked in AMI

**Symptom**: Node fails during cinc, before cfn-signal. The error in cinc.log: `service[nvidia-fabricmanager] (aws-parallelcluster-entrypoints::nvidia_config line 45) had an error: expected '0' but got '1'`. Timing is ~3 minutes (cinc timeout), not 68 seconds.

**What we tried that didn't work**:
- Thinking `systemctl disable` and `systemctl mask` behave the same — they don't
- Unmasking the service in OnNodeConfigured — too late, cinc already failed

**The actual cause**: When you `systemctl mask` a service, a symlink points the unit file to `/dev/null`. When cinc's `fabric_manager :configure` recipe runs `systemctl start`, it always returns exit code 1 on a masked service. cinc sees the error, marks the recipe FATAL, and the node fails bootstrap.

> ##### DANGER
>
> `systemctl mask nvidia-fabricmanager` in your AMI = **always FATAL during cinc**. There is no workaround — the service must be in `enabled` or `disabled` state at AMI bake time.
{: .block-danger }

The behavior by state:

| systemctl state | cinc `start` behavior |
|---|---|
| `enabled` | If already running → no-op ✅ |
| `disabled` | Starts the service → success or failure |
| `masked` | **Always returns error code 1 — always FATAL** ❌ |

**The fix**:

```bash
# ✅ Correct
systemctl enable nvidia-fabricmanager

# ❌ Never do this in an AMI
systemctl mask nvidia-fabricmanager
```

---

## Cause 4: Conf Hash Reboot Loop — The `cfn-hup` Trap

**Symptom**: Cluster is stable, jobs are running. You update the CloudFormation stack. Suddenly, nodes go DOWN one by one. slurmctld log shows: `Node compute-node-1: appears to have a different slurm.conf hash`. The node recovers to IDLE, then immediately goes DOWN again. The loop repeats every few minutes indefinitely.

**What we tried that didn't work**:
- Restarting slurmctld manually — loop continues
- Updating slurm.conf on all nodes — hashes keep drifting
- Increasing `SlurmdTimeout` — doesn't stop the DOWN state

**The actual cause**: When you update the CloudFormation stack, cfn-hup (running on the HeadNode) detects the change and restarts slurmctld. Each restart regenerates slurm.conf and computes a new hash. It broadcasts this hash to ComputeNodes. If a node's hash doesn't match, slurmctld marks it DOWN. clustermgtd sees DOWN → triggers `/sbin/reboot`. Node reboots, syncs new conf, goes IDLE, heartbeats — but if cfn-hup fires again, the cycle repeats.

```
T+0s    CloudFormation stack update
T+5s    cfn-hup fires → restarts slurmctld
T+10s   slurmctld regenerates slurm.conf, new hash = HASH_V2
T+20s   compute-node-1 still has HASH_V1 → reports mismatch
T+25s   slurmctld marks compute-node-1 DOWN
T+30s   clustermgtd sees DOWN → /sbin/reboot
T+90s   node reboots, gets HASH_V2, goes IDLE
T+95s   cfn-hup fires again → cycle repeats
```

> ##### WARNING
>
> This loop runs indefinitely and will interrupt long-running jobs silently. A job running for 2 hours gets killed mid-execution the moment you touch the CloudFormation stack.
{: .block-warning }

**The fix** — add to your pcluster cluster config:

```yaml
CustomSlurmSettings:
  - "DebugFlags=NO_CONF_HASH"
```

This suppresses conf hash mismatch checks. Safe in a managed CloudFormation environment where you trust the config to be consistent.

---

## Why Standalone EC2 Tests Don't Catch These

| Aspect | Standalone EC2 | pcluster Compute Node |
|---|---|---|
| cinc | Not running | Runs automatically |
| Reboot checks | You control | cinc finalize auto-checks |
| Service state | You manage | cinc enforces `enabled`; masked = failure |
| Conf hash | No slurmd | slurmctld/slurmd compare on every heartbeat |
| cfn-hup | Not present | Watches stack, restarts services |

Every one of these four causes requires ParallelCluster's internal orchestration to trigger. A standalone instance will never hit them. This is why you have to test in a real cluster.

---

## Diagnosis Flowchart

**Node dies at ~68 seconds?**
- Check `dmesg` for "Detected Pre-NVL5" or "kbifCacheVFInfo" panic
- **→ Cause 1**: `ib_umad` missing. Bake into AMI.

**Node dies ~5–7 minutes after cfn-signal success?**
- Check `/var/log/parallelcluster/cinc.log` for "Executing: /sbin/reboot"
- **→ Cause 2**: `reboot-required` trap. Add dpkg hook to AMI.

**Node fails during cinc, before cfn-signal (~3 min)?**
- Check cinc.log for `service[nvidia-fabricmanager] had an error: expected '0' but got '1'`
- **→ Cause 3**: fabricmanager masked. Use `enable`, not `mask`.

**Node cycles UP → DOWN → IDLE → UP repeatedly?**
- Check slurmctld log for "appears to have a different slurm.conf hash"
- **→ Cause 4**: conf hash loop. Add `DebugFlags=NO_CONF_HASH`.

---

> **Series**: Distributed Training on AWS ParallelCluster
>
> [← Part 1: How ParallelCluster Works](/pages/pcluster-series-1-internals/) | **Part 2: Why Your p6-b200 Nodes Keep Rebooting** | [Part 3: Building a Custom AMI →](/pages/pcluster-series-3-custom-ami/)
{: .block-tip }
