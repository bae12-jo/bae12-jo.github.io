---
title: "분산 학습 - Part 3: p6-b200을 위한 커스텀 AMI 만들기"
author: Bailey Sohyeon Cho
layout: post
lang: ko
---

# AWS ParallelCluster에서 p6-b200 문제를 해결하는 커스텀 AMI 만들기

> **시리즈**: AWS ParallelCluster로 분산 학습 환경 구축하기
>
> [← Part 2: p6-b200 노드가 계속 재부팅되는 이유](/pages/pcluster-series-2-reboots-ko/)

Part 2를 읽으셨다면 p6-b200 노드가 계속 재부팅되는 이유를 알 것입니다: 커널 모듈 없음, 마스킹된 서비스, 유령 재부팅 플래그, 커널 버전 불일치. 이 글은 해결책입니다. 네 가지 근본 원인을 커스텀 AMI에 모두 베이크해서 노드가 항상 깨끗하게 부팅되도록 만들겠습니다.

---

## 왜 AMI에 수정사항을 베이크해야 하는가?

OnNodeStart와 OnNodeConfigured 스크립트는 마지막 트윅에는 유용하지만, 문제가 근본적인 경우에는 신뢰할 수 없습니다:

- 커널 모듈은 cinc의 NVL5 초기화 **이전에** 존재해야 합니다
- Systemd 서비스는 cinc가 실행되기 **전에** 언마스킹되어 있어야 합니다
- OnNodeConfigured에서 reboot 플래그를 제거해도 최종 cfn-signal을 손상시킵니다

> ##### TIP
>
> 한 번 빌드하고 어디서나 배포하세요. AMI에 수정사항을 베이크하면 모든 노드 교체에서 재현성이 보장되고, 시작 시 apt-get 없이 부트스트랩이 빨라지며, AMI 빌드 중에 — 콘솔 접근이 가능할 때 — 실패가 표면화됩니다.
{: .block-tip }

---

## 다섯 가지 AMI 체크리스트

각 항목은 Part 2의 근본 원인 하나를 해결합니다. 순서대로 적용하세요.

---

### 1. `ib_umad` 영구 로드 (Pre-NVL5 패닉 해결)

`ib_umad` 커널 모듈은 NVL5 fabric 초기화 이전에 필요합니다. 없으면 노드가 ~68초에 패닉합니다.

```bash
sudo apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils
sudo modprobe ib_umad
echo "ib_umad" | sudo tee -a /etc/modules
```

검증:

```bash
lsmod | grep ib_umad
# 예상: ib_umad    45056  0
```

> ##### WARNING
>
> `echo "ib_umad" >> /etc/modules` 줄이 핵심입니다. 이 줄 없이는 AMI 빌드 시점에는 모듈이 존재하지만, 클러스터에서 노드가 부팅될 때 자동으로 로드되지 않습니다.
{: .block-warning }

---

### 2. `nvlsm` 설치 (NVLink 서브넷 매니저 해결)

NVIDIA NVLink 서브넷 매니저는 NVL5와 B200 GPU의 fabric 토폴로지를 관리합니다.

```bash
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.10.11-1_amd64.deb
sudo dpkg -i nvlsm_2025.10.11-1_amd64.deb
```

검증:

```bash
dpkg -l | grep nvlsm
# 예상: ii  nvlsm  2025.10.11-1  amd64  SM
```

---

### 3. `nvidia-fabricmanager` 활성화 (마스킹된 서비스 실패 해결)

> ##### DANGER
>
> 서비스를 **활성화**하세요, 비활성화하거나 마스킹하지 마세요. AMI에서 fabricmanager가 마스킹되면 cinc가 시작하지 못하고 부트스트랩이 FATAL로 실패합니다. `enabled` + 이미 실행 중 = cinc no-op. `masked` = 항상 FATAL.
{: .block-danger }

```bash
sudo systemctl enable nvidia-fabricmanager

# 검증
sudo systemctl is-enabled nvidia-fabricmanager
# 예상: enabled
```

AMI 빌드 중 `systemctl start`를 실행하지 마세요. cinc가 시작을 처리합니다.

---

### 4. `reboot-required` 플래그 억제 (유령 재부팅 해결)

```bash
sudo tee /etc/apt/apt.conf.d/99-no-reboot-required > /dev/null <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
```

이 훅은 모든 `apt` 작업 후 실행되어 cinc 자체 패키지 설치 중 생성된 것을 포함한 모든 reboot-required 플래그를 제거합니다.

자동 재부팅 트리거도 비활성화:

```bash
sudo systemctl mask unattended-upgrades
sudo apt remove --purge needrestart -y
```

검증:

```bash
cat /etc/apt/apt.conf.d/99-no-reboot-required
```

---

### 5. Lustre 클라이언트 모듈 설치 (FSx 마운트 실패 해결)

> ##### WARNING
>
> **커널 버전 드리프트는 조용한 킬러입니다.** 직접 경험했습니다: AMI는 커널 `6.8.0-1050-aws`에서 빌드됐지만, cinc 중에 `linux-modules-extra`가 커널을 `6.8.0-1052-aws`로 업그레이드했습니다. `-1050`용 lustre 모듈은 `-1052`에서 로드할 수 없어 `FATAL: lustre[mount fsx] exit code 19 (ENODEV)`가 발생했습니다.
{: .block-warning }

```bash
sudo apt install -y lustre-client-modules-$(uname -r) lustre-client-utils
```

검증:

```bash
dpkg -l | grep lustre-client-modules
# 노드에서 실행될 정확한 커널 버전과 일치해야 합니다
uname -r  # 모든 설치 후 어느 커널인지 확인
```

**전략**: 먼저 모든 패키지 설치(`linux-modules-extra` 포함)를 실행하고, 마지막에 lustre 모듈을 설치하세요 — `uname -r`이 최종 커널 버전을 반영한 후. 이것이 일치를 보장하는 유일한 방법입니다.

---

## OnNodeStart를 안전망으로 활용

탄탄한 AMI가 있어도 OnNodeStart에 이 내용을 멱등성 있는 안전망으로 추가하세요:

```bash
#!/bin/bash
# 안전망 — 멱등성, 여러 번 실행해도 안전

# 1. ib_umad 로드 확인
sudo modprobe ib_umad

# 2. 잔여 reboot 플래그 제거 (이중 안전)
sudo rm -f /var/run/reboot-required /var/run/reboot-required.pkgs

# 3. fabricmanager가 활성화 상태인지 확인 (마스킹 아님)
sudo systemctl unmask nvidia-fabricmanager 2>/dev/null || true
sudo systemctl enable nvidia-fabricmanager
```

---

## 스냅샷 전 AMI 정리

AMI 생성 전에 ParallelCluster 메타데이터를 정리하세요:

```bash
sudo rm -f /opt/parallelcluster/system_info
sudo /usr/local/sbin/ami_cleanup.sh
```

> ##### DANGER
>
> `ami_cleanup.sh`를 건너뛰면 스냅샷이 빌드 인스턴스의 노드별 상태를 그대로 담게 됩니다. ParallelCluster가 AMI를 비표준으로 감지하고 일부 초기화 단계가 예측 불가능하게 동작할 수 있습니다.
{: .block-danger }

---

## 커널 버전 드리프트: 조용한 킬러

이 부분은 진단이 가장 어렵고 우리가 직접 경험한 원인이라 특별히 강조합니다.

**무슨 일이 있었나**: AMI를 커널 `6.8.0-1050-aws`에서 빌드했습니다. 그 커널용 lustre 모듈을 설치했습니다. 클러스터 노드가 시작되자 cinc의 init 단계에서 `linux-modules-extra`를 설치했고, 이것이 커널을 `6.8.0-1052-aws`로 업그레이드했습니다. 우리 lustre 모듈은 `-1050`용으로 빌드됐습니다. 불일치로 인해:

```
FATAL: lustre[mount fsx] (aws-parallelcluster-environment::fsx line 33)
Mixlib::ShellOut::ShellCommandFailed: exit code 19
```

`exit code 19 = ENODEV` — 실행 중인 커널에 커널 모듈이 단순히 존재하지 않습니다.

**효과 있었던 해결책**: `linux-modules-extra` 설치(업그레이드를 트리거하는) 후 `uname -r`을 확인하면 새 커널이 표시됩니다. *그* 버전용 lustre를 설치하세요:

```bash
# AMI 빌드 스크립트 순서:
apt install -y linux-modules-extra-$(uname -r)   # 커널 업그레이드 가능
# ... 다른 패키지들 ...
# 마지막에, 모든 설치 후:
apt install -y lustre-client-modules-$(uname -r)  # 최종 커널 버전 사용
```

---

## 실패 패턴과 근본 원인 테이블

| 증상 | 타이밍 | 근본 원인 |
|------|--------|---------|
| 노드 종료, dmesg에 "Pre-NVL5" | ~68초, cfn-signal 이전 | `ib_umad` 없음 |
| cfn-signal 성공 후 노드 재부팅 | cfn-signal 후 ~7분 | `/var/run/reboot-required` → cinc finalize 재부팅 |
| cinc가 `expected '0' but got '1'`로 실패 | ~3분, cfn-signal 이전 | AMI에서 `nvidia-fabricmanager`가 masked 상태 |
| FSx 마운트가 `ENODEV`로 실패 | ~5~6분, cinc finalize 중 | lustre 모듈 커널 버전 불일치 |
| 노드가 무작위로 중단, NVLink 오류 | 가변적 (시간/일) | `nvlsm` 미설치 |

---

## 전체 AMI 빌드 스크립트

```bash
#!/bin/bash
# pcluster 3.15 Ubuntu 22.04 p6-b200용 AMI 빌드 스크립트
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# Step 1: 기본 패키지 설치 (커널 업그레이드 가능)
apt-get update -qq
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils

# Step 2: ib_umad 로드 및 영구화
modprobe ib_umad
echo "ib_umad" | tee -a /etc/modules

# Step 3: nvlsm 설치
wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.10.11-1_amd64.deb
dpkg -i nvlsm_2025.10.11-1_amd64.deb
rm nvlsm_2025.10.11-1_amd64.deb

# Step 4: fabricmanager 활성화 (절대 마스킹 금지)
systemctl enable nvidia-fabricmanager

# Step 5: reboot 플래그 억제
tee /etc/apt/apt.conf.d/99-no-reboot-required > /dev/null <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
systemctl mask unattended-upgrades
apt remove --purge needrestart -y

# Step 6: 최종 커널 버전용 lustre 설치 (모든 업그레이드 후)
apt install -y lustre-client-modules-$(uname -r) lustre-client-utils

# Step 7: 정리
rm -f /opt/parallelcluster/system_info
/usr/local/sbin/ami_cleanup.sh

echo "AMI 빌드 완료. 커널: $(uname -r)"
```

---

## 검증 체크리스트

빌드 후 스냅샷 전 실행하세요:

```bash
# 1. ib_umad 로드됨
lsmod | grep ib_umad && echo "✓ ib_umad" || echo "✗ ib_umad 없음"

# 2. nvlsm 설치됨
dpkg -l | grep -q nvlsm && echo "✓ nvlsm" || echo "✗ nvlsm 없음"

# 3. fabricmanager 활성화됨 (마스킹 아님)
systemctl is-enabled nvidia-fabricmanager | grep -q "^enabled$" && echo "✓ fabricmanager" || echo "✗ fabricmanager 활성화 안 됨"

# 4. reboot 억제 훅 존재
[ -f /etc/apt/apt.conf.d/99-no-reboot-required ] && echo "✓ reboot 훅" || echo "✗ reboot 훅 없음"

# 5. lustre 모듈이 현재 커널과 일치
dpkg -l lustre-client-modules-$(uname -r) 2>/dev/null | grep -q "^ii" && echo "✓ lustre ($(uname -r))" || echo "✗ $(uname -r)용 lustre 없음"
```

5개 모두 통과해야 합니다. 하나라도 실패하면 AMI가 불완전한 것입니다.

---

## 최종 결과

7번의 AMI 반복 끝에:

- **베이스**: pcluster 3.15 Ubuntu 22.04 (`ami-0dc2ffd737d30ca8a`, us-east-2)
- **결과**: `ami-0fc2bf7c1bc3ed007` (us-east-2), `ami-0cd865a4b36faa2b5` (us-east-1)
- **검증**: 20분 이상 안정, slurm job `R 20:10`, 노드 alloc 상태

다섯 가지 체크리스트를 AMI 빌드 시점에 한 번 적용하면 네 가지 근본 원인이 모두 해결됩니다. 더 이상 68초 패닉도, 7분 유령 재부팅도, 마스킹된 서비스 실패도, 커널 불일치 FSx 오류도 없습니다.

---

> **시리즈**: AWS ParallelCluster로 분산 학습 환경 구축하기
>
> [← Part 2: p6-b200 노드가 계속 재부팅되는 이유](/pages/pcluster-series-2-reboots-ko/) | **Part 3: 커스텀 AMI 만들기**
{: .block-tip }
