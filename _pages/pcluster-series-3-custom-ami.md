---
title: "Distributed Training - Part 4: Building a Custom AMI for p6-b200"
author: Bailey Sohyeon Cho
layout: post
lang: en
lang_peer: /pages/pcluster-series-3-custom-ami-ko/
---

# Building a Custom AMI to Fix p6-b200 on AWS ParallelCluster

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 3: Why Your p6-b200 Nodes Keep Rebooting](/pages/pcluster-series-2-reboots/)

Part 3 identified four root causes. This post fixes them — permanently, at AMI build time.

---

## Why AMI, not scripts

OnNodeStart and OnNodeConfigured scripts are fine for things that run after cinc. They're not fine when the problem is in the cinc phase itself.

`ib_umad` needs to be loaded before cinc starts. `nvidia-fabricmanager` needs to be in the right state before cinc tries to start it. The `reboot-required` flag needs to be cleared at the dpkg level, not at the script level. None of these can be reliably fixed by a hook script running after the fact.

---

## The five fixes

### 1. `ib_umad` in /etc/modules

Without `ib_umad` loaded at boot, fabricmanager fails its precheck and the node panics at ~68 seconds.

```bash
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils
modprobe ib_umad
echo "ib_umad" >> /etc/modules
```

The `echo` line is what matters. Without it the module is present in the AMI but won't autoload when nodes boot in the cluster.

Verify: `lsmod | grep ib_umad` should show `ib_umad    45056  0`.

---

### 2. `nvlsm`

The NVIDIA NVLink Subnet Manager handles fabric topology for NVL5 and B200.

```bash
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.10.11-1_amd64.deb
dpkg -i nvlsm_2025.10.11-1_amd64.deb
```

---

### 3. Enable fabricmanager, don't mask it

> ##### DANGER
>
> `enabled` state means cinc's `:start` is a no-op if fabricmanager is already running. `masked` state means cinc's `:start` always returns exit code 1 and the bootstrap fails. There is no workaround — the state in the AMI determines this.
{: .block-danger }

```bash
systemctl enable nvidia-fabricmanager
```

Don't run `systemctl start` during AMI build. Let cinc handle the actual start.

---

### 4. dpkg hook to suppress reboot-required

```bash
tee /etc/apt/apt.conf.d/99-no-reboot-required > /dev/null <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
systemctl mask unattended-upgrades
apt remove --purge needrestart -y
```

The hook runs after every `apt` operation — including during cinc — and deletes the reboot flag before cinc finalize can read it.

---

### 5. Lustre client modules — install last

> ##### WARNING
>
> The kernel version you build the AMI on may not be the kernel version the node runs. On our cluster, `linux-modules-extra` triggered a kernel upgrade from `6.8.0-1050-aws` to `6.8.0-1052-aws` during cinc init. Our lustre modules were built for `-1050`. The result: `FATAL: lustre[mount fsx] exit code 19 (ENODEV)`.
{: .block-warning }

Install `linux-modules-extra` first (it may upgrade the kernel), then check `uname -r`, then install lustre against whatever kernel is now running:

```bash
apt install -y linux-modules-extra-$(uname -r)   # may upgrade kernel
# ... other packages ...
# at the very end:
apt install -y lustre-client-modules-$(uname -r) lustre-client-utils
```

The order matters. Installing lustre before `linux-modules-extra` can leave you with a version mismatch.

---

## OnNodeStart as a safety net

Even with a solid AMI, these are worth having in OnNodeStart:

```bash
#!/bin/bash
modprobe ib_umad
rm -f /var/run/reboot-required /var/run/reboot-required.pkgs
systemctl unmask nvidia-fabricmanager 2>/dev/null || true
systemctl enable nvidia-fabricmanager
```

They're idempotent. They cost nothing if everything is already correct.

---

## Cleanup before snapshotting

```bash
rm -f /opt/parallelcluster/system_info
/usr/local/sbin/ami_cleanup.sh
```

> ##### DANGER
>
> Skip `ami_cleanup.sh` and the AMI carries node-specific state from the build instance. ParallelCluster detects it as non-standard and some initialization steps behave unpredictably.
{: .block-danger }

---

## Full build script

```bash
#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils

modprobe ib_umad
echo "ib_umad" | tee -a /etc/modules

wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.10.11-1_amd64.deb
dpkg -i nvlsm_2025.10.11-1_amd64.deb
rm nvlsm_2025.10.11-1_amd64.deb

systemctl enable nvidia-fabricmanager

tee /etc/apt/apt.conf.d/99-no-reboot-required > /dev/null <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
systemctl mask unattended-upgrades
apt remove --purge needrestart -y

# install lustre last — after any kernel upgrades above
apt install -y lustre-client-modules-$(uname -r) lustre-client-utils

rm -f /opt/parallelcluster/system_info
/usr/local/sbin/ami_cleanup.sh

echo "done. kernel: $(uname -r)"
```

---

## Verify before snapshotting

```bash
lsmod | grep ib_umad && echo "ok: ib_umad" || echo "MISSING: ib_umad"
dpkg -l | grep -q nvlsm && echo "ok: nvlsm" || echo "MISSING: nvlsm"
systemctl is-enabled nvidia-fabricmanager | grep -q "^enabled$" && echo "ok: fabricmanager" || echo "WRONG STATE: fabricmanager"
[ -f /etc/apt/apt.conf.d/99-no-reboot-required ] && echo "ok: reboot hook" || echo "MISSING: reboot hook"
dpkg -l lustre-client-modules-$(uname -r) 2>/dev/null | grep -q "^ii" && echo "ok: lustre ($(uname -r))" || echo "MISSING: lustre for $(uname -r)"
```

---

## Failure pattern reference

| What you see | When | Cause |
|---|---|---|
| Node terminates, "Pre-NVL5" in dmesg | ~68s, before cfn-signal | `ib_umad` not loaded at boot |
| Node reboots after cfn-signal success | ~7min after cfn-signal | `/var/run/reboot-required` → cinc finalize reboot |
| cinc fails, `expected '0' but got '1'` | ~3min, before cfn-signal | `nvidia-fabricmanager` masked in AMI |
| FSx mount fails with `ENODEV` | ~5-6min, cinc finalize | lustre module kernel version mismatch |
| NVLink errors hours/days in | variable | `nvlsm` not installed |

---

## What we ended up with

After 7 AMI iterations:

- Base: pcluster 3.15 Ubuntu 22.04
- Result: `ami-00a519913cff04008` (us-east-1)
- Verified: 20+ minutes stable, slurm job running, node in alloc state

---

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 3: Why Your p6-b200 Nodes Keep Rebooting](/pages/pcluster-series-2-reboots/) | You are here: **Part 4: Building a Custom AMI**
{: .block-tip }
