---
title: "GPU Cluster 세팅하기"
author: Bailey Sohyeon Cho
date: 2026-04-20
category: Infrastructure
layout: post
---

<div class="lang-ko">

# P6-B200(Hopper) 런치 AMI 만들기

> **기간**: 2026-04-19 ~ 2026-04-20  
> **목표**: pcluster 3.15 + p6-b200.48xlarge 컴퓨트 노드 안정 부팅  
> **결과**: AMI v7 (`ami-00a519913cff04008`) 으로 20분+ 안정 확인

---

## 타임라인 & 발견된 이슈

---

### Phase 1 — 첫 번째 AMI 시도 (`ami-0f63da494d0937d0b`)
**증상**: 노드 부팅 직후 68초 만에 shutting-down

**원인**: `nvidia-fabricmanager`가 부팅 시 `ib_umad` 커널 모듈 없이 시작됨

```
fabricmanager 시작 → "Detected Pre-NVL5 system" → 패닉
→ cinc fabric_manager :configure 실패 → cfn-signal -e 1 → EC2 종료
```

> ##### TIP
>
> `systemctl disable`은 자동시작만 막고 이미 실행 중인 서비스는 못 막음.  
> 실행 중인 서비스를 막으려면 `systemctl stop`을 써야 함.
{: .block-tip }

---

### Phase 2 — AMI v2: `mask` 적용
**시도**: AMI 빌드 시 `systemctl mask nvidia-fabricmanager`

**새로운 증상**: cfn-signal 성공 후 7분 뒤 갑자기 reboot

**원인 발견 (SSM 진단)**:

```
/var/run/reboot-required  ← 파일 존재
패키지: linux-image-6.8.0-1052-aws, linux-base
```

`linux-modules-extra` apt 설치 시 커널 업그레이드가 딸려와서 `reboot-required` 플래그 생성.  
cinc finalize 단계에서 이 파일을 감지하고 `reboot` 실행.

> ##### WARNING
>
> 7분이라는 딜레이 때문에 fabricmanager 문제인 줄 착각하기 쉬움.  
> 실제 원인은 apt post-install 훅이 생성하는 `reboot-required` 파일.
{: .block-warning }

---

### Phase 3 — AMI v3: reboot-required 제거
**시도**: OnNodeStart에서 `rm -f /var/run/reboot-required` 추가

**새로운 증상**: 3분 만에 죽음 (더 빨라짐)

**원인**:

```
AMI v3 builder: fabricmanager masked 상태로 bake됨
cinc init → nvidia_config recipe → systemctl start nvidia-fabricmanager
→ masked unit은 start 자체가 error exit → FATAL → cfn-signal 실패
```

> ##### DANGER
>
> AMI bake 시 `masked` 상태로 굽지 말 것.  
> cinc는 서비스가 이미 running이면 no-op이지만, masked면 **항상 FATAL** 로 실패.
{: .block-danger }

---

### Phase 4 — AMI v4: `disabled` + ib_umad /etc/modules
**시도**: `disable`만 하고 `ib_umad`를 `/etc/modules`에 등록 → 부팅 시 자동 로드

**새로운 증상**: cinc init에서 fabricmanager start 실패 (19분 생존)

**원인**: ib_umad는 로드됐지만 `nvlsm` 서비스/모듈 없어서 fabricmanager 시작 실패

> ##### TIP
>
> p6-b200은 `ib_umad` 외에 `nvlsm`(NVLink State Manager)도 반드시 필요.
{: .block-tip }

---

### Phase 5 — AMI v5: 공식 솔루션 적용
**솔루션 출처**: AWS 내부 티켓 (amanrsh)

```bash
apt install linux-modules-extra-$(uname -r) infiniband-diags ibutils -y
modprobe ib_umad
echo "ib_umad" >> /etc/modules
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.06.5-1_amd64.deb
dpkg -i nvlsm_2025.06.5-1_amd64.deb
systemctl enable nvidia-fabricmanager
```

**새로운 증상**: cfn-signal 성공 후 5분 뒤 reboot (Phase 2와 동일 패턴)

> ##### WARNING
>
> AMI bake 시 `reboot-required`를 삭제해도 소용없음.  
> cinc init 자체가 패키지를 설치하면서 **다시 생성**함.
{: .block-warning }

---

### Phase 6 — AMI v6: dpkg post-invoke 훅
**솔루션**: apt 설정에 dpkg 후처리 훅 추가

```
# /etc/apt/apt.conf.d/99-no-reboot-required
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
```

**새로운 증상**: cfn-signal 성공, 5분 생존 후 FATAL 에러

```
FATAL: lustre[mount fsx] (aws-parallelcluster-environment::fsx line 33)
Mixlib::ShellOut::ShellCommandFailed: exit code 19
```

**원인**: `exit code 19 = ENODEV` = 커널 모듈 없음 (FSx Lustre)

---

### Phase 7 — AMI v7: lustre 커널 모듈 추가 **[성공]**

**원인 분석**:
- 헤드노드 커널: `6.8.0-1050-aws` → lustre 모듈 `-1050` 버전으로 설치됨
- 컴퓨트 노드 커널: `6.8.0-1052-aws` (linux-modules-extra 설치 시 업그레이드)
- lustre 모듈 버전 불일치 → `ENODEV`

```bash
apt install lustre-client-modules-$(uname -r) lustre-client-utils -y
```

> ##### TIP
>
> `linux-modules-extra` 설치 시 커널이 업그레이드될 수 있음.  
> AMI 빌드 후 `uname -r`로 최종 커널 버전을 확인하고 모든 모듈을 그 버전으로 설치할 것.
{: .block-tip }

**결과**: **20분+ 안정적으로 running, job R 20:10, 슬럼 노드 alloc**

---

## 핵심 교훈 정리

### 1. `systemctl` 상태별 cinc 동작

| 상태 | 의미 | cinc `start` 시 |
|------|------|----------------|
| `enabled` | 자동시작 O | 이미 running이면 no-op |
| `disabled` | 자동시작 X | start 시도 → 성공/실패 |
| `masked` | 완전 차단 | **항상 실패** |

> ##### DANGER
>
> cinc가 `start`를 호출하므로 `masked` 상태로 AMI를 bake하면 **항상 실패**.  
> AMI bake 전 반드시 `unmask + enable` 상태로 만들 것.
{: .block-danger }

---

### 2. `/var/run/reboot-required` 함정

```
# /etc/apt/apt.conf.d/99-no-reboot-required
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
```

> ##### WARNING
>
> `needrestart` 제거, `unattended-upgrades` mask만으론 부족.  
> **cinc 자체**가 패키지 설치 중 플래그를 생성하므로 dpkg post-invoke 훅이 유일한 해법.
{: .block-warning }

---

### 3. pcluster cinc 레시피 흐름

```
OnNodeStart (S3 hook)
  ↓
cinc init  (aws-parallelcluster-entrypoints::init)
  → nvidia_config
    → service[nvidia-fabricmanager] :start  ← 실패하면 cfn-signal -e 1
  ↓
slurmd 시작  →  cfn-signal 0  →  슬럼 노드 IDLE
  ↓
cinc finalize  (aws-parallelcluster-entrypoints::finalize)
  → reboot_required 체크   ← /var/run/reboot-required 있으면 reboot
  → fsx mount              ← lustre 모듈 필요
```

---

### 4. AMI 빌드 시 cleanup 필수

```bash
sudo rm -f /opt/parallelcluster/system_info
sudo /usr/local/sbin/ami_cleanup.sh
```

---

### 5. 디버깅 방법론

| 방법 | 언제 사용 |
|------|---------|
| EC2 console output | 부팅 초기 오류 |
| SSM `send-command` | 노드 살아있을 때 실시간 진단 |
| slurmctld journal | 노드 상태 전환 타임라인 |
| dpkg 로그 | 패키지 설치 시점 추적 |

> ##### TIP
>
> 노드가 죽은 후 console output은 shutdown 단계만 보임.  
> **살아있는 동안** SSM으로 체크해야 진짜 원인을 잡을 수 있음.
{: .block-tip }

---

## 최종 AMI v7 구성 요약

```bash
# 기반 AMI: pcluster 3.15 ubuntu2204 (ami-0f8eed74478b388d3)

# 1. 필수 패키지
apt install linux-modules-extra-$(uname -r) infiniband-diags ibutils -y
wget .../nvlsm_2025.06.5-1_amd64.deb && dpkg -i nvlsm_2025.06.5-1_amd64.deb
apt install lustre-client-modules-$(uname -r) lustre-client-utils -y

# 2. 커널 모듈 영구 등록
echo "ib_umad" >> /etc/modules

# 3. systemd
systemctl enable nvidia-fabricmanager
systemctl mask unattended-upgrades
apt remove --purge needrestart -y

# 4. dpkg 훅
echo 'DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };' \
  > /etc/apt/apt.conf.d/99-no-reboot-required

# 5. cleanup
rm -f /opt/parallelcluster/system_info
/usr/local/sbin/ami_cleanup.sh
```

**결과 AMI**: `ami-00a519913cff04008`  
**검증**: 20분+ 안정, slurm job R 20:10, 노드 alloc 상태 유지

</div>

<div class="lang-en" style="display:none">

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

</div>
