---
title: "GPU Cluster 세팅하기"
author: Bailey Sohyeon Cho
date: 2026-04-20
category: Infrastructure
layout: post
lang: ko
---

# P6-B200 on AWS ParallelCluster

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

**처음에 한 실수**: `systemctl disable`로 막으려 했지만 효과 없음.  
`disable`은 자동시작만 막고 이미 실행 중인 서비스는 못 막음.

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

**처음에 한 실수**: 7분이라는 딜레이 때문에 fabricmanager 문제인 줄 알았음.  
실제 원인은 apt post-install 훅.

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

**처음에 한 실수**: AMI 빌더에서 `mask` 상태를 그대로 bake했음.  
cinc는 서비스가 이미 running이면 no-op, masked면 항상 실패.

---

### Phase 4 — AMI v4: `disabled` (not masked) + ib_umad /etc/modules
**시도**: `disable`만 하고 `ib_umad`를 `/etc/modules`에 등록 → 부팅 시 자동 로드

**새로운 증상**: cinc init에서 fabricmanager start 실패 (19분 생존)

**원인**: ib_umad는 로드됐지만 `nvlsm` 서비스/모듈 없어서 fabricmanager 시작 실패

**처음에 한 실수**: ib_umad만 넣으면 된다고 생각.  
p6-b200은 `nvlsm`(NVLink State Manager)도 필요.

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

**원인**: cinc init 과정 자체에서 패키지 설치 → `reboot-required` 파일 재생성.  
AMI bake 시 파일 없앴어도 cinc 실행 중에 다시 생김.

**처음에 한 실수**: reboot-required를 AMI에서만 지우면 된다고 생각.  
하지만 cinc init 자체가 패키지를 설치하면서 다시 만듦.

---

### Phase 6 — AMI v6: dpkg post-invoke 훅
**솔루션**: apt 설정에 dpkg 후처리 훅 추가

```
/etc/apt/apt.conf.d/99-no-reboot-required
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
```

**새로운 증상**: cfn-signal 성공, 5분 생존 후 FATAL 에러

```
FATAL: lustre[mount fsx] (aws-parallelcluster-environment::fsx line 33)
Mixlib::ShellOut::ShellCommandFailed: exit code 19
```

**원인**: `exit code 19 = ENODEV` = 커널 모듈 없음 (FSx Lustre)

**처음에 한 실수**: reboot 문제만 추적하느라 FSx Lustre 마운트 이슈를 못 봤음.

---

### Phase 7 — AMI v7: lustre 커널 모듈 추가 **[성공]**

**원인 분석**:
- 헤드노드 커널: `6.8.0-1050-aws` → lustre 모듈 `-1050` 버전으로 설치됨
- 컴퓨트 노드 커널: `6.8.0-1052-aws` (linux-modules-extra 설치 시 업그레이드)
- lustre 모듈 버전 불일치 → `ENODEV`

**솔루션**:
```bash
apt install lustre-client-modules-$(uname -r) lustre-client-utils -y
```

**결과**: **20분+ 안정적으로 running, job R 20:10, 슬럼 노드 alloc**

---

## 핵심 교훈 정리

### 1. `systemctl` 상태별 cinc 동작

| 상태 | 의미 | cinc `start` 시 |
|------|------|----------------|
| `enabled` | 자동시작 O | 이미 running이면 no-op |
| `disabled` | 자동시작 X | start 시도 → 성공/실패 |
| `masked` | 완전 차단 | **항상 실패** |

> **결론**: cinc가 `start`를 호출하므로 `masked`는 절대 금지.  
> AMI bake 전 반드시 `unmask + enable` 상태로 만들 것.

---

### 2. `/var/run/reboot-required` 함정

- `needrestart` 패키지 제거만으론 부족
- `unattended-upgrades` mask만으론 부족
- **cinc 자체가 패키지 설치 중 플래그를 생성함**
- 유일한 안전한 해법: dpkg post-invoke 훅으로 항상 삭제

```
# /etc/apt/apt.conf.d/99-no-reboot-required
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
```

---

### 3. 커널 버전 드리프트

- `linux-modules-extra` 설치 → 커널 마이너 버전 업그레이드 유발 가능
- 커널 의존 모듈(lustre, 특정 driver)은 **정확한 커널 버전에 맞게 빌드됨**
- AMI 빌드 시 설치한 커널 버전 = 컴퓨트 노드 실행 커널 버전 반드시 확인

```bash
# AMI 빌드 후 검증
uname -r  # 이 버전으로 모든 커널 모듈이 설치됐는지 확인
dpkg -l | grep lustre  # 버전 일치 여부
dpkg -l | grep ib_umad
```

---

### 4. pcluster cinc 레시피 흐름 이해 필수

```
OnNodeStart (S3 hook)
  ↓
cloud-init (userdata)
  ↓
cinc init  (aws-parallelcluster-entrypoints::init)
  → nvidia_config
    → service[nvidia-fabricmanager] :start  ← 실패하면 cfn-signal -e 1
  ↓
slurmd 시작
cfn-signal 0  → 슬럼 노드 IDLE
  ↓
cinc finalize  (aws-parallelcluster-entrypoints::finalize)
  → reboot_required 체크
    → /var/run/reboot-required 있으면 reboot  ← 7분 후 죽는 원인
  → fsx mount
    → lustre 모듈 필요  ← ENODEV 원인
```

---

### 5. AMI 빌드 시 cleanup 필수

```bash
sudo rm -f /opt/parallelcluster/system_info
sudo /usr/local/sbin/ami_cleanup.sh
```

생략하면 pcluster가 "공식 AMI 아님" 경고 + 일부 동작 이상 가능.

---

### 6. 디버깅 방법론

| 방법 | 언제 사용 |
|------|---------|
| EC2 console output | 부팅 초기 (user-data 단계) 오류 |
| SSM `send-command` | 노드가 살아있을 때 실시간 진단 |
| slurmctld journal | 노드 상태 전환 타임라인 |
| dpkg 로그 | 패키지 설치 시점 추적 |

> **핵심**: 노드가 죽은 후 console output은 shutdown 단계만 보임.  
> **살아있는 동안** SSM으로 체크해야 진짜 원인을 잡을 수 있음.

---

### 7. 흔히 하는 실수 Top 5

1. **standalone 테스트 통과 ≠ cluster 테스트 통과**  
   cinc 없는 환경에서 테스트하면 cinc 레시피 충돌을 못 잡음

2. **g4dn으로 AMI 빌드 후 p6-b200 배포**  
   GPU 아키텍처가 달라서 드라이버/모듈 호환성 미검증 상태

3. **AMI 빌드 시 커널 버전 고정 안 함**  
   `uname -r` 결과가 빌드/런타임에 다를 수 있음 (linux-modules-extra 설치 시 특히)

4. **cfn-signal 성공 = 노드 안정 아님**  
   cfn-signal 후 cinc finalize에서도 reboot 발생 가능

5. **에러 메시지 표면만 보기**  
   "fabricmanager failed"가 원인이 아니라 증상.  
   실제 원인은 ib_umad 없음 / nvlsm 없음 / lustre 모듈 불일치 등

---

## 최종 AMI v7 구성 요약

```
기반 AMI: pcluster 3.15 ubuntu2204 official (ami-0f8eed74478b388d3)
빌드 인스턴스: g4dn.2xlarge

추가 패키지:
  - linux-modules-extra-$(uname -r)       # ib_umad 포함
  - infiniband-diags ibutils
  - nvlsm_2025.06.5-1_amd64.deb           # NVLink5/NVSwitch
  - lustre-client-modules-$(uname -r)     # FSx Lustre (커널 버전 일치 필수)
  - lustre-client-utils

systemd 설정:
  - echo "ib_umad" >> /etc/modules         # 부팅 시 자동 로드
  - systemctl enable nvidia-fabricmanager  # enabled (masked/disabled 아님)
  - systemctl mask unattended-upgrades
  - apt remove --purge needrestart

apt 훅:
  - /etc/apt/apt.conf.d/99-no-reboot-required
    DPkg::Post-Invoke { "rm -f /var/run/reboot-required ..."; };

cleanup:
  - rm -f /opt/parallelcluster/system_info
  - /usr/local/sbin/ami_cleanup.sh

결과 AMI: ami-00a519913cff04008
검증: 20분+ 안정, slurm job R 20:10, 노드 alloc 상태 유지
```
