---
title: "Distributed Training - Part 3: Building a Custom AMI for p6-b200"
author: Bailey Sohyeon Cho
layout: post
lang: en
---

# Building a Custom AMI to Fix p6-b200 on AWS ParallelCluster

> **Series**: Distributed Training on AWS ParallelCluster
>
> [← Part 2: Why Your p6-b200 Nodes Keep Rebooting](/pages/pcluster-series-2-reboots/)

If you've read Part 2, you know why your p6-b200 nodes keep rebooting: missing kernel modules, masked services, phantom reboot flags, and kernel version mismatches. This post is the fix. We'll bake all four root causes into a custom AMI so your nodes boot cleanly, every time.

---

## Why Bake Fixes Into the AMI?

OnNodeStart and OnNodeConfigured scripts are useful for last-minute tweaks, but they're not reliable when the problem is fundamental:

- Kernel modules need to be present **before** cinc's NVL5 initialization
- Systemd services must be unmasked **before** cinc runs
- Reboot flags corrupt the final cfn-signal even when you clear them in OnNodeConfigured

> ##### TIP
>
> Build once, deploy everywhere. Baking fixes into the AMI gives you reproducibility across every node replacement, faster bootstrap (no apt-get at launch time), and failures that surface during AMI build — when you have full console access — not in production.
{: .block-tip }

---

## The Five-Item AMI Checklist

Each item addresses one root cause from Part 2. Apply them in order.

---

### 1. Load `ib_umad` Permanently (Fixes Pre-NVL5 Panic)

The `ib_umad` kernel module is required before NVL5 fabric initialization. Without it, nodes panic at ~68 seconds.

```bash
sudo apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils
sudo modprobe ib_umad
echo "ib_umad" | sudo tee -a /etc/modules
```

Verify:

```bash
lsmod | grep ib_umad
# Expected: ib_umad    45056  0
```

> ##### WARNING
>
> The `echo "ib_umad" >> /etc/modules` line is critical. Without it, the module is present at AMI-build time but won't auto-load when the node boots in the cluster.
{: .block-warning }

---

### 2. Install `nvlsm` (Fixes NVLink Subnet Manager)

The NVIDIA NVLink Subnet Manager manages the fabric topology for NVL5 and B200 GPUs.

```bash
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.10.11-1_amd64.deb
sudo dpkg -i nvlsm_2025.10.11-1_amd64.deb
```

Verify:

```bash
dpkg -l | grep nvlsm
# Expected: ii  nvlsm  2025.10.11-1  amd64  SM
```

---

### 3. Enable `nvidia-fabricmanager` (Fixes Masked Service Failure)

> ##### DANGER
>
> **Enable** the service, never disable or mask it. When fabricmanager is masked in the AMI, cinc cannot start it and the bootstrap fails FATALLY. `enabled` + already running = cinc no-op. `masked` = always FATAL.
{: .block-danger }

```bash
sudo systemctl enable nvidia-fabricmanager

# Verify
sudo systemctl is-enabled nvidia-fabricmanager
# Expected: enabled
```

Do not run `systemctl start` during AMI build. Cinc will handle the start.

---

### 4. Suppress `reboot-required` Flags (Fixes Phantom Reboots)

```bash
sudo tee /etc/apt/apt.conf.d/99-no-reboot-required > /dev/null <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
```

This hook runs after every `apt` operation and removes any reboot-required flags — including the ones created by cinc during its own package installations.

Also disable automatic reboot triggers:

```bash
sudo systemctl mask unattended-upgrades
sudo apt remove --purge needrestart -y
```

Verify:

```bash
cat /etc/apt/apt.conf.d/99-no-reboot-required
```

---

### 5. Install Lustre Client Modules (Fixes FSx Mount Failures)

> ##### WARNING
>
> **Kernel version drift is the silent killer.** We experienced this firsthand: our AMI was built on kernel `6.8.0-1050-aws`, but cluster nodes booted on `6.8.0-1052-aws` after `linux-modules-extra` triggered a kernel upgrade during cinc. The lustre module for `-1050` couldn't load on `-1052`, causing `FATAL: lustre[mount fsx] exit code 19 (ENODEV)`.
{: .block-warning }

```bash
sudo apt install -y lustre-client-modules-$(uname -r) lustre-client-utils
```

Verify:

```bash
dpkg -l | grep lustre-client-modules
# Must match the exact kernel version that will run on your nodes
uname -r  # Check which kernel you're on after all installs
```

**Strategy**: Run ALL package installations first (including `linux-modules-extra`), then install lustre modules at the very end — after `uname -r` reflects the final kernel version. This is the only way to guarantee a match.

---

## OnNodeStart as a Safety Net

Even with a solid AMI, add these to OnNodeStart as idempotent safeguards:

```bash
#!/bin/bash
# Safety net — idempotent, safe to run multiple times

# 1. Ensure ib_umad is loaded
sudo modprobe ib_umad

# 2. Clear any lingering reboot flags (belt-and-suspenders)
sudo rm -f /var/run/reboot-required /var/run/reboot-required.pkgs

# 3. Verify fabricmanager is enabled (not masked)
sudo systemctl unmask nvidia-fabricmanager 2>/dev/null || true
sudo systemctl enable nvidia-fabricmanager
```

---

## AMI Cleanup Before Snapshotting

Before creating the AMI, clean up ParallelCluster metadata:

```bash
sudo rm -f /opt/parallelcluster/system_info
sudo /usr/local/sbin/ami_cleanup.sh
```

> ##### DANGER
>
> Skipping `ami_cleanup.sh` means the snapshot carries node-specific state from the build instance. ParallelCluster will detect the AMI as non-standard, and some initialization steps may behave unpredictably.
{: .block-danger }

---

## Kernel Version Drift: The Silent Killer

This deserves special attention because it's the hardest cause to diagnose and it hit us directly.

**What happened**: We built the AMI on kernel `6.8.0-1050-aws`. We installed lustre modules for that kernel. When cluster nodes launched, cinc's init phase installed `linux-modules-extra`, which upgraded the kernel to `6.8.0-1052-aws`. Our lustre modules were built for `-1050`. The mismatch caused:

```
FATAL: lustre[mount fsx] (aws-parallelcluster-environment::fsx line 33)
Mixlib::ShellOut::ShellCommandFailed: exit code 19
```

`exit code 19 = ENODEV` — the kernel module simply doesn't exist for the running kernel.

**The fix that worked**: After installing `linux-modules-extra` (which triggers the upgrade), check `uname -r` — it will show the new kernel. Then install lustre for *that* version:

```bash
# In AMI build script order:
apt install -y linux-modules-extra-$(uname -r)   # May upgrade kernel
# ... other packages ...
# At the very end, after all installs:
apt install -y lustre-client-modules-$(uname -r)  # Uses final kernel version
```

---

## Failure Pattern to Root Cause Table

| Symptom | Timing | Root Cause |
|---------|--------|-----------|
| Node terminates, "Pre-NVL5" in dmesg | ~68s, before cfn-signal | `ib_umad` missing |
| Node reboots after successful cfn-signal | ~7 min after cfn-signal | `/var/run/reboot-required` → cinc finalize reboot |
| cinc fails with `expected '0' but got '1'` | ~3 min, before cfn-signal | `nvidia-fabricmanager` masked in AMI |
| FSx mount fails with `ENODEV` | ~5-6 min, during cinc finalize | lustre module kernel version mismatch |
| Nodes randomly stop working, NVLink errors | Variable (hours/days) | `nvlsm` not installed |

---

## Full AMI Build Script

```bash
#!/bin/bash
# AMI build script for p6-b200 on pcluster 3.15 Ubuntu 22.04
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# Step 1: Install base packages (may trigger kernel upgrade)
apt-get update -qq
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils

# Step 2: Load ib_umad and persist
modprobe ib_umad
echo "ib_umad" | tee -a /etc/modules

# Step 3: Install nvlsm
wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.10.11-1_amd64.deb
dpkg -i nvlsm_2025.10.11-1_amd64.deb
rm nvlsm_2025.10.11-1_amd64.deb

# Step 4: Enable fabricmanager (never mask)
systemctl enable nvidia-fabricmanager

# Step 5: Suppress reboot flags
tee /etc/apt/apt.conf.d/99-no-reboot-required > /dev/null <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
systemctl mask unattended-upgrades
apt remove --purge needrestart -y

# Step 6: Install lustre for FINAL kernel version (after all upgrades)
apt install -y lustre-client-modules-$(uname -r) lustre-client-utils

# Step 7: Cleanup
rm -f /opt/parallelcluster/system_info
/usr/local/sbin/ami_cleanup.sh

echo "AMI build complete. Kernel: $(uname -r)"
```

---

## Verification Checklist

Run these after build, before snapshotting:

```bash
# 1. ib_umad loaded
lsmod | grep ib_umad && echo "✓ ib_umad" || echo "✗ ib_umad MISSING"

# 2. nvlsm installed
dpkg -l | grep -q nvlsm && echo "✓ nvlsm" || echo "✗ nvlsm MISSING"

# 3. fabricmanager enabled (not masked)
systemctl is-enabled nvidia-fabricmanager | grep -q "^enabled$" && echo "✓ fabricmanager" || echo "✗ fabricmanager NOT ENABLED"

# 4. reboot suppression hook exists
[ -f /etc/apt/apt.conf.d/99-no-reboot-required ] && echo "✓ reboot hook" || echo "✗ reboot hook MISSING"

# 5. lustre modules match current kernel
dpkg -l lustre-client-modules-$(uname -r) 2>/dev/null | grep -q "^ii" && echo "✓ lustre ($(uname -r))" || echo "✗ lustre MISSING for $(uname -r)"
```

All five must pass. If any fails, the AMI is incomplete.

---

## What We Ended Up With

After 7 AMI iterations, the final result:

- **Base**: pcluster 3.15 Ubuntu 22.04 (`ami-0dc2ffd737d30ca8a`, us-east-2)
- **Result**: `ami-0fc2bf7c1bc3ed007` (us-east-2), `ami-0cd865a4b36faa2b5` (us-east-1)
- **Verified**: 20+ minutes stable, slurm job `R 20:10`, node in alloc state

The five-item checklist, applied once at AMI build time, eliminated all four root causes. No more 68-second panics. No more 7-minute phantom reboots. No more masked service failures. No more kernel mismatch FSx errors.

---

> **Series**: Distributed Training on AWS ParallelCluster
>
> [← Part 2: Why Your p6-b200 Nodes Keep Rebooting](/pages/pcluster-series-2-reboots/) | **Part 3: Building a Custom AMI**
{: .block-tip }
