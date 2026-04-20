---
title: "Part 4: p6-b200을 위한 커스텀 AMI 만들기"
author: Bailey Sohyeon Cho
layout: post
lang: ko
lang_peer: /pages/pcluster-series-3-custom-ami/
---

# AWS ParallelCluster p6-b200 문제를 해결하는 커스텀 AMI 만들기

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 3: p6-b200 노드 재부팅 원인](/pages/pcluster-series-2-reboots-ko/)

Part 3에서 네 가지 근본 원인을 확인했습니다. 이 글은 수정입니다 — AMI 빌드 시점에 전부 해결합니다.

---

## 왜 스크립트가 아닌 AMI인가

OnNodeStart와 OnNodeConfigured는 cinc 이후에 실행되는 것에는 유용합니다. 문제가 cinc 단계 자체에 있을 때는 통하지 않습니다.

`ib_umad`는 cinc가 시작하기 *전에* 로드되어야 합니다. `nvidia-fabricmanager`는 cinc가 시작하려 하기 *전에* 올바른 상태여야 합니다. `reboot-required` 플래그는 스크립트 레벨이 아닌 dpkg 레벨에서 잡아야 합니다. 이 중 어느 것도 사후 훅 스크립트로 확실하게 고칠 수 없습니다.

---

## 다섯 가지 수정

### 1. `ib_umad`를 /etc/modules에

`ib_umad` 없이 부팅하면 fabricmanager가 사전 검사에서 실패하고 노드가 ~68초에 패닉합니다.

```bash
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils
modprobe ib_umad
echo "ib_umad" >> /etc/modules
```

`echo` 줄이 핵심입니다. 없으면 AMI에 모듈이 있어도 클러스터 부팅 시 자동 로드가 안 됩니다.

검증: `lsmod | grep ib_umad`가 `ib_umad    45056  0`을 보여야 합니다.

---

### 2. `nvlsm`

NVIDIA NVLink 서브넷 매니저 — NVL5와 B200의 fabric 토폴로지를 관리합니다.

```bash
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/nvlsm_2025.10.11-1_amd64.deb
dpkg -i nvlsm_2025.10.11-1_amd64.deb
```

---

### 3. fabricmanager enable, mask 금지

> ##### DANGER
>
> `enabled` 상태 = cinc의 `:start`가 이미 실행 중이면 no-op. `masked` 상태 = cinc의 `:start`가 항상 exit code 1 반환. AMI의 상태가 이를 결정합니다. 우회 방법이 없습니다.
{: .block-danger }

```bash
systemctl enable nvidia-fabricmanager
```

AMI 빌드 중 `systemctl start`는 실행하지 마세요. cinc가 처리합니다.

---

### 4. dpkg 훅으로 reboot-required 억제

```bash
tee /etc/apt/apt.conf.d/99-no-reboot-required > /dev/null <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
systemctl mask unattended-upgrades
apt remove --purge needrestart -y
```

모든 `apt` 작업 후 — cinc 중에 발생하는 것도 포함해서 — 실행되어 플래그를 cinc finalize가 읽기 전에 삭제합니다.

---

### 5. Lustre 클라이언트 모듈 — 마지막에 설치

> ##### WARNING
>
> AMI를 빌드하는 커널과 노드가 실행되는 커널이 다를 수 있습니다. 우리 클러스터에서 `linux-modules-extra` 설치가 커널을 `6.8.0-1050-aws`에서 `6.8.0-1052-aws`로 업그레이드했습니다. lustre 모듈은 `-1050`용으로 빌드됐습니다. 결과: `FATAL: lustre[mount fsx] exit code 19 (ENODEV)`.
{: .block-warning }

`linux-modules-extra`를 먼저 설치하고 (커널 업그레이드 가능), `uname -r`을 확인한 다음, 그 커널용 lustre를 설치하세요:

```bash
apt install -y linux-modules-extra-$(uname -r)   # 커널 업그레이드 가능
# ... 다른 패키지들 ...
# 마지막에:
apt install -y lustre-client-modules-$(uname -r) lustre-client-utils
```

순서가 중요합니다. `linux-modules-extra` 전에 lustre를 설치하면 버전 불일치가 발생합니다.

---

## OnNodeStart를 안전망으로

AMI가 탄탄해도 OnNodeStart에 이것들을 넣어두면 좋습니다:

```bash
#!/bin/bash
modprobe ib_umad
rm -f /var/run/reboot-required /var/run/reboot-required.pkgs
systemctl unmask nvidia-fabricmanager 2>/dev/null || true
systemctl enable nvidia-fabricmanager
```

멱등성이 있습니다. 이미 올바른 상태면 비용이 없습니다.

---

## 스냅샷 전 정리

```bash
rm -f /opt/parallelcluster/system_info
/usr/local/sbin/ami_cleanup.sh
```

> ##### DANGER
>
> `ami_cleanup.sh`를 건너뛰면 스냅샷이 빌드 인스턴스의 노드별 상태를 그대로 담습니다. ParallelCluster가 비표준으로 감지하고 일부 초기화 단계가 예측 불가능하게 동작합니다.
{: .block-danger }

---

## 전체 빌드 스크립트

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

# lustre는 반드시 마지막에 — 커널 업그레이드가 모두 끝난 후
apt install -y lustre-client-modules-$(uname -r) lustre-client-utils

rm -f /opt/parallelcluster/system_info
/usr/local/sbin/ami_cleanup.sh

echo "완료. 커널: $(uname -r)"
```

---

## 스냅샷 전 검증

```bash
lsmod | grep ib_umad && echo "ok: ib_umad" || echo "없음: ib_umad"
dpkg -l | grep -q nvlsm && echo "ok: nvlsm" || echo "없음: nvlsm"
systemctl is-enabled nvidia-fabricmanager | grep -q "^enabled$" && echo "ok: fabricmanager" || echo "상태 오류: fabricmanager"
[ -f /etc/apt/apt.conf.d/99-no-reboot-required ] && echo "ok: reboot 훅" || echo "없음: reboot 훅"
dpkg -l lustre-client-modules-$(uname -r) 2>/dev/null | grep -q "^ii" && echo "ok: lustre ($(uname -r))" || echo "없음: $(uname -r)용 lustre"
```

---

## 실패 패턴 정리

| 증상 | 타이밍 | 원인 |
|------|--------|------|
| 종료, dmesg에 "Pre-NVL5" | ~68초, cfn-signal 전 | 부팅 시 `ib_umad` 미로드 |
| cfn-signal 성공 후 재부팅 | cfn-signal 후 ~7분 | `reboot-required` → cinc finalize |
| cinc 실패, `expected '0' but got '1'` | ~3분, cfn-signal 전 | AMI에서 fabricmanager masked |
| FSx 마운트 ENODEV | ~5~6분, cinc finalize | lustre 모듈 커널 버전 불일치 |
| NVLink 오류, 노드 중단 | 가변적 (시간~일) | nvlsm 미설치 |

---

## 최종 결과

AMI 7번 반복 끝에:

- 베이스: pcluster 3.15 Ubuntu 22.04
- 결과: `ami-00a519913cff04008` (us-east-1)
- 검증: 20분 이상 안정, slurm job 실행 중, 노드 alloc 상태

---

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 3: p6-b200 노드 재부팅 원인](/pages/pcluster-series-2-reboots-ko/) | 현재: **Part 4: 커스텀 AMI 만들기**
{: .block-tip }
