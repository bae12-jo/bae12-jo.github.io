---
title: "Setting Up a GPU Cluster"
author: Bailey Sohyeon Cho
date: 2026-04-20
category: Infrastructure
layout: post
lang: en
lang_peer: /infrastructure/2026-04-20-p6b200-boot-retrospective
---

# Building a Launch AMI for P6-B200 on AWS ParallelCluster

> **Period**: Apr 19 – Apr 20, 2026  
> **Goal**: Stable compute node boot with pcluster 3.15 + p6-b200.48xlarge  
> **Result**: AMI v7 (`ami-00a519913cff04008`) — 20+ minutes stable

---

## Timeline & Issues Found

---

### Phase 1 — First AMI Attempt (`ami-0f63da494d0937d0b`)
**Symptom**: Node shut down 68 seconds after boot

**Root cause**: `nvidia-fabricmanager` started without `ib_umad` kernel module loaded

```
fabricmanager start → "Detected Pre-NVL5 system" → panic
→ cinc fabric_manager :configure failed → cfn-signal -e 1 → EC2 terminated
```

> ##### TIP
>
> `systemctl disable` only prevents autostart — it does NOT stop a running service.  
> Use `systemctl stop` to stop a service that's already running.
{: .block-tip }

---

### Phase 2 — AMI v2: Applying `mask`
**Attempt**: `systemctl mask nvidia-fabricmanager` during AMI build

**New symptom**: Unexpected reboot 7 minutes after cfn-signal success

**Root cause (diagnosed via SSM)**:

```
/var/run/reboot-required  ← file exists
packages: linux-image-6.8.0-1052-aws, linux-base
```

Installing `linux-modules-extra` triggered a kernel upgrade, creating a `reboot-required` flag.  
cinc finalize detects this file and executes `reboot`.

> ##### WARNING
>
> The 7-minute delay makes it easy to blame fabricmanager.  
> The real cause is the `reboot-required` file created by apt post-install hooks.
{: .block-warning }

---

### Phase 3 — AMI v3: Removing reboot-required
**Attempt**: Added `rm -f /var/run/reboot-required` in OnNodeStart

**New symptom**: Died faster — within 3 minutes

**Root cause**:

```
AMI v3 baked with fabricmanager in masked state
cinc init → nvidia_config recipe → systemctl start nvidia-fabricmanager
→ masked unit causes error exit → FATAL → cfn-signal failure
```

> ##### DANGER
>
> Never bake an AMI with a service in `masked` state.  
> cinc is a no-op if the service is already running, but **always fails FATALLY** if masked.
{: .block-danger }

---

### Phase 4 — AMI v4: `disabled` + ib_umad in /etc/modules
**Attempt**: Use `disable` only, register `ib_umad` in `/etc/modules` for autoload on boot

**New symptom**: fabricmanager start failure during cinc init (survived 19 minutes)

**Root cause**: `ib_umad` loaded but `nvlsm` missing — fabricmanager couldn't start

> ##### TIP
>
> p6-b200 requires both `ib_umad` **and** `nvlsm` (NVLink State Manager).
{: .block-tip }

---

### Phase 5 — AMI v5: Official Solution Applied
**Source**: AWS internal ticket (amanrsh)

```bash
apt install linux-modules-extra-$(uname -r) infiniband-diags ibutils -y
modprobe ib_umad
echo "ib_umad" >> /etc/modules
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.06.5-1_amd64.deb
dpkg -i nvlsm_2025.06.5-1_amd64.deb
systemctl enable nvidia-fabricmanager
```

**New symptom**: Reboot 5 minutes after cfn-signal success (same pattern as Phase 2)

> ##### WARNING
>
> Deleting `reboot-required` during AMI build is not enough.  
> cinc init installs packages and **recreates** the file at runtime.
{: .block-warning }

---

### Phase 6 — AMI v6: dpkg post-invoke hook
**Solution**: Add a dpkg post-processing hook to apt config

```
# /etc/apt/apt.conf.d/99-no-reboot-required
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
```

**New symptom**: cfn-signal success, FATAL error after 5 minutes

```
FATAL: lustre[mount fsx] (aws-parallelcluster-environment::fsx line 33)
Mixlib::ShellOut::ShellCommandFailed: exit code 19
```

**Root cause**: `exit code 19 = ENODEV` — FSx Lustre kernel module missing

---

### Phase 7 — AMI v7: Adding Lustre Kernel Module **[SUCCESS]**

**Analysis**:
- HeadNode kernel: `6.8.0-1050-aws` → lustre module built for `-1050`
- Compute node kernel: `6.8.0-1052-aws` (upgraded by linux-modules-extra install)
- Lustre module version mismatch → `ENODEV`

```bash
apt install lustre-client-modules-$(uname -r) lustre-client-utils -y
```

> ##### TIP
>
> Installing `linux-modules-extra` may upgrade the kernel minor version.  
> After AMI build, verify with `uname -r` and install all kernel-dependent modules against that exact version.
{: .block-tip }

**Result**: **20+ minutes stable, slurm job R 20:10, node in alloc state**

---

## Key Lessons

### 1. cinc behavior by systemctl state

| State | Meaning | When cinc calls `start` |
|-------|---------|------------------------|
| `enabled` | Autostart ON | no-op if already running |
| `disabled` | Autostart OFF | attempts start → may succeed/fail |
| `masked` | Fully blocked | **always FATAL failure** |

> ##### DANGER
>
> Since cinc calls `start`, baking an AMI with `masked` state **always fails**.  
> Always ensure `unmask + enable` before baking the AMI.
{: .block-danger }

---

### 2. The `/var/run/reboot-required` Trap

```
# /etc/apt/apt.conf.d/99-no-reboot-required
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
```

> ##### WARNING
>
> Removing `needrestart` or masking `unattended-upgrades` alone is not enough.  
> **cinc itself** creates the flag during package installation — the dpkg hook is the only reliable fix.
{: .block-warning }

---

### 3. pcluster cinc Recipe Flow

```
OnNodeStart (S3 hook)
  ↓
cinc init  (aws-parallelcluster-entrypoints::init)
  → nvidia_config
    → service[nvidia-fabricmanager] :start  ← cfn-signal -e 1 on failure
  ↓
slurmd starts  →  cfn-signal 0  →  Slurm node IDLE
  ↓
cinc finalize  (aws-parallelcluster-entrypoints::finalize)
  → reboot_required check   ← reboots if /var/run/reboot-required exists
  → fsx mount               ← requires lustre kernel module
```

---

### 4. AMI Cleanup is Mandatory

```bash
sudo rm -f /opt/parallelcluster/system_info
sudo /usr/local/sbin/ami_cleanup.sh
```

---

### 5. Debugging Methodology

| Method | When to use |
|--------|-------------|
| EC2 console output | Early boot errors |
| SSM `send-command` | Live diagnosis while node is up |
| slurmctld journal | Node state transition timeline |
| dpkg log | Track package installation timing |

> ##### TIP
>
> After a node dies, console output only shows the shutdown phase.  
> Diagnose via SSM **while the node is still alive** to catch the real cause.
{: .block-tip }

---

## Final AMI v7 Build Summary

```bash
# Base AMI: pcluster 3.15 ubuntu2204 (ami-0f8eed74478b388d3)

# 1. Required packages
apt install linux-modules-extra-$(uname -r) infiniband-diags ibutils -y
wget .../nvlsm_2025.06.5-1_amd64.deb && dpkg -i nvlsm_2025.06.5-1_amd64.deb
apt install lustre-client-modules-$(uname -r) lustre-client-utils -y

# 2. Persist kernel module
echo "ib_umad" >> /etc/modules

# 3. systemd
systemctl enable nvidia-fabricmanager
systemctl mask unattended-upgrades
apt remove --purge needrestart -y

# 4. dpkg hook
echo 'DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };' \
  > /etc/apt/apt.conf.d/99-no-reboot-required

# 5. Cleanup
rm -f /opt/parallelcluster/system_info
/usr/local/sbin/ami_cleanup.sh
```

**Result AMI**: `ami-00a519913cff04008`  
**Verified**: 20+ minutes stable, slurm job R 20:10, node in alloc state
