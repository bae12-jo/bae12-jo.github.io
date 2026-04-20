---
title: "GPU 클러스터 구성하기"
author: Bailey Sohyeon Cho
date: 2026-04-20
category: Infrastructure
layout: post
lang: ko
lang_peer: /pages/p6b200-boot-retrospective-en/
---

# AWS ParallelCluster에서 P6-B200 런치 AMI 만들기

> **기간**: 2026년 4월 19일 – 20일  
> **목표**: pcluster 3.15 + p6-b200.48xlarge 컴퓨트 노드 안정 부팅  
> **결과**: AMI v7 (`ami-00a519913cff04008`) — 20분 이상 안정 확인

---

## 타임라인 & 발견된 이슈

---

### Phase 1 — 첫 AMI 시도 (`ami-0f63da494d0937d0b`)
**증상**: 부팅 후 68초 만에 노드 종료

**원인**: `ib_umad` 커널 모듈 없이 `nvidia-fabricmanager` 시작됨

```
fabricmanager 시작 → "Detected Pre-NVL5 system" → 패닉
→ cinc fabric_manager :configure 실패 → cfn-signal -e 1 → EC2 종료
```

> ##### TIP
>
> `systemctl disable`은 자동시작만 막을 뿐, 이미 실행 중인 서비스는 건드리지 않습니다.  
> 실행 중인 서비스를 멈추려면 `systemctl stop`을 사용하세요.
{: .block-tip }

---

### Phase 2 — AMI v2: `mask` 적용
**시도**: AMI 빌드 시 `systemctl mask nvidia-fabricmanager`

**새로운 증상**: cfn-signal 성공 후 7분 만에 갑자기 재부팅

**원인 (SSM 진단으로 발견)**:

```
/var/run/reboot-required  ← 파일 존재
패키지: linux-image-6.8.0-1052-aws, linux-base
```

`linux-modules-extra` 설치 시 커널 업그레이드가 같이 이루어지며 `reboot-required` 플래그 생성.  
cinc finalize 단계에서 이 파일을 감지하고 `reboot` 실행.

> ##### WARNING
>
> 7분이라는 딜레이 때문에 fabricmanager 문제로 착각하기 쉽습니다.  
> 실제 원인은 apt post-install 훅이 만들어낸 `reboot-required` 파일입니다.
{: .block-warning }

---

### Phase 3 — AMI v3: reboot-required 제거 시도
**시도**: OnNodeStart에서 `rm -f /var/run/reboot-required` 추가

**새로운 증상**: 오히려 더 빠르게 종료 — 3분 이내

**원인**:

```
AMI v3가 fabricmanager masked 상태로 베이크됨
cinc init → nvidia_config recipe → systemctl start nvidia-fabricmanager
→ masked unit은 항상 오류 종료 → FATAL → cfn-signal 실패
```

> ##### DANGER
>
> 서비스를 `masked` 상태로 AMI를 절대 베이크하지 마세요.  
> 서비스가 이미 실행 중이면 cinc는 no-op이지만, masked 상태에서는 **항상 FATAL로 실패**합니다.
{: .block-danger }

---

### Phase 4 — AMI v4: `disabled` + ib_umad /etc/modules 등록
**시도**: `disable`만 적용하고 `ib_umad`를 `/etc/modules`에 등록해 부팅 시 자동 로드

**새로운 증상**: cinc init 중 fabricmanager 시작 실패 (19분 생존)

**원인**: `ib_umad`는 로드됐지만 `nvlsm` 없음 — fabricmanager 시작 불가

> ##### TIP
>
> p6-b200은 `ib_umad`와 **`nvlsm`(NVLink State Manager)** 모두 필요합니다.
{: .block-tip }

---

### Phase 5 — AMI v5: 공식 솔루션 적용
**출처**: AWS 내부 티켓 (amanrsh)

```bash
apt install linux-modules-extra-$(uname -r) infiniband-diags ibutils -y
modprobe ib_umad
echo "ib_umad" >> /etc/modules
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.06.5-1_amd64.deb
dpkg -i nvlsm_2025.06.5-1_amd64.deb
systemctl enable nvidia-fabricmanager
```

**새로운 증상**: cfn-signal 성공 후 5분 만에 재부팅 (Phase 2와 동일 패턴)

> ##### WARNING
>
> AMI 빌드 시 `reboot-required`를 삭제하는 것만으로는 부족합니다.  
> cinc init이 런타임에 패키지를 설치하면서 **해당 파일을 다시 생성**합니다.
{: .block-warning }

---

### Phase 6 — AMI v6: dpkg post-invoke 훅
**솔루션**: apt 설정에 dpkg 후처리 훅 추가

```
# /etc/apt/apt.conf.d/99-no-reboot-required
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
```

**새로운 증상**: cfn-signal 성공, 5분 후 FATAL 에러

```
FATAL: lustre[mount fsx] (aws-parallelcluster-environment::fsx line 33)
Mixlib::ShellOut::ShellCommandFailed: exit code 19
```

**원인**: `exit code 19 = ENODEV` — FSx Lustre 커널 모듈 없음

---

### Phase 7 — AMI v7: Lustre 커널 모듈 추가 **[성공]**

**분석**:
- 헤드노드 커널: `6.8.0-1050-aws` → lustre 모듈이 `-1050` 버전으로 설치됨
- 컴퓨트 노드 커널: `6.8.0-1052-aws` (linux-modules-extra 설치 시 업그레이드됨)
- lustre 모듈 버전 불일치 → `ENODEV`

```bash
apt install lustre-client-modules-$(uname -r) lustre-client-utils -y
```

> ##### TIP
>
> `linux-modules-extra` 설치 시 커널 마이너 버전이 업그레이드될 수 있습니다.  
> AMI 빌드 후 `uname -r`로 확인하고, 모든 커널 의존 모듈을 해당 버전에 맞게 설치하세요.
{: .block-tip }

**결과**: **20분 이상 안정, slurm job R 20:10, 노드 alloc 상태 유지**

---

## 핵심 교훈

### 1. systemctl 상태별 cinc 동작

| 상태 | 의미 | cinc가 `start` 호출 시 |
|------|------|----------------------|
| `enabled` | 자동시작 ON | 이미 실행 중이면 no-op |
| `disabled` | 자동시작 OFF | 시작 시도 → 성공/실패 |
| `masked` | 완전 차단 | **항상 FATAL 실패** |

> ##### DANGER
>
> cinc가 `start`를 호출하므로, `masked` 상태로 AMI를 베이크하면 **항상 실패**합니다.  
> AMI 베이크 전 반드시 `unmask + enable` 상태로 만드세요.
{: .block-danger }

---

### 2. `/var/run/reboot-required` 함정

```
# /etc/apt/apt.conf.d/99-no-reboot-required
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
```

> ##### WARNING
>
> `needrestart` 제거나 `unattended-upgrades` masking만으로는 부족합니다.  
> **cinc 자체가** 패키지 설치 중 이 플래그를 생성합니다 — dpkg 훅이 유일한 확실한 해결책입니다.
{: .block-warning }

---

### 3. pcluster cinc 레시피 흐름

```
OnNodeStart (S3 hook)
  ↓
cinc init  (aws-parallelcluster-entrypoints::init)
  → nvidia_config
    → service[nvidia-fabricmanager] :start  ← 실패 시 cfn-signal -e 1
  ↓
slurmd 시작  →  cfn-signal 0  →  Slurm 노드 IDLE
  ↓
cinc finalize  (aws-parallelcluster-entrypoints::finalize)
  → reboot_required 체크   ← /var/run/reboot-required 있으면 reboot
  → fsx mount              ← lustre 커널 모듈 필요
```

---

### 4. AMI cleanup 필수

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
> 노드가 죽은 후 console output은 shutdown 단계만 보입니다.  
> **노드가 살아있는 동안** SSM으로 체크해야 진짜 원인을 잡을 수 있습니다.
{: .block-tip }

---

## 최종 AMI v7 빌드 요약

```bash
# Base AMI: pcluster 3.15 ubuntu2204 (ami-0f8eed74478b388d3)

# 1. 필수 패키지
apt install linux-modules-extra-$(uname -r) infiniband-diags ibutils -y
wget .../nvlsm_2025.06.5-1_amd64.deb && dpkg -i nvlsm_2025.06.5-1_amd64.deb
apt install lustre-client-modules-$(uname -r) lustre-client-utils -y

# 2. 커널 모듈 영구 등록
echo "ib_umad" >> /etc/modules

# 3. systemd 설정
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
**검증**: 20분 이상 안정, slurm job R 20:10, 노드 alloc 상태 유지
