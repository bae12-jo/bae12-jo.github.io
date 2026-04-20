---
title: "분산 학습 - Part 1: AWS ParallelCluster의 내부 동작 원리"
author: Bailey Sohyeon Cho
layout: post
lang: ko
---

# AWS ParallelCluster는 실제로 어떻게 동작하는가

> **시리즈**: AWS ParallelCluster로 분산 학습 환경 구축하기
> **1/3편** — [Part 2: p6-b200 노드가 계속 재부팅되는 이유 →](/pages/pcluster-series-2-reboots-ko/)

`pcluster create-cluster`를 실행하면 눈에 보이지 않는 곳에서 꽤 복잡한 일이 벌어집니다. 대부분의 ML 엔지니어는 ParallelCluster를 CloudFormation과 EC2를 감싼 단순한 래퍼 정도로 생각합니다. 하지만 실제로는 Chef 쿡북, 커스텀 데몬, cloud-init 단계, 타이밍이 중요한 작업들이 백그라운드에서 조용히 실행되는 완전한 오케스트레이션 레이어가 존재합니다. **동일한 AMI와 스크립트도 standalone EC2 인스턴스와 ParallelCluster 내부에서 완전히 다르게 동작**하기 때문에 이 구조를 이해하는 것이 중요합니다.

이 글에서는 그 숨겨진 메커니즘을 자세히 살펴봅니다. 클러스터 생성 시 실제로 무슨 일이 일어나는지, 왜 특정 설정이 설명 없이 실패하는지, 그리고 왜 로컬에서는 잘 동작하던 GPU 설정이 프로덕션에서 실패하는지 보여드리겠습니다.

---

## 생성 시퀀스: `pcluster create-cluster`부터 `slurmd` 실행까지

ParallelCluster가 노드를 부팅할 때 일어나는 단계별 과정입니다:

```
pcluster create-cluster
    ↓
CloudFormation이 스택 생성 (HeadNode, ComputeNode, VPC, 보안 그룹)
    ↓
EC2가 pcluster 전용 AMI로 인스턴스 시작
    ↓
cloud-init phase 1: UserData 스크립트 실행
    ↓
cloud-init phase 2: cinc (Chef) 부트스트랩 실행
    ↓
cinc가 pcluster 쿡북 실행 (nvidia_config.rb, slurm_install.rb, efa_driver.rb 등)
    ↓
재부팅 (/var/run/reboot-required 감지 시)
    ↓
CustomActions 실행 (OnNodeConfigured 단계)
    ↓
cfn-signal이 CloudFormation에 완료 신호 전송
    ↓
ComputeNode에서 slurmd 시작
HeadNode에서 slurmctld 시작
    ↓
clustermgtd (pcluster 데몬)가 노드를 감지하고 idle 상태로 표시
```

각 단계는 매우 중요합니다. 어느 하나라도 실패하거나 중단되면 전체 클러스터 생성이 무한정 중단됩니다.

---

## cinc (Chef) 부트스트랩: 실제 설정 엔진

ParallelCluster는 시스템 설정에 임의의 스크립트를 사용하지 않고 **cinc**(Chef Infra Client 포크)를 사용해 오케스트레이션된 쿡북을 실행합니다. 이는 cloud-init 이후, CustomActions 이전에 자동으로 실행됩니다.

cinc가 각 노드에서 하는 작업:

### nvidia_config.rb 쿡북

GPU 노드에서 가장 중요한 쿡북입니다. 엄격한 순서로 실행됩니다:

```ruby
gdrcopy :configure
  # gdrdrv 커널 모듈 로드
  # GPU Direct RDMA 활성화 (NVLink, EFA, fabric manager에 필요)

fabric_manager :configure
  # nvidia-fabricmanager 시작
  # 중요: 이미 실행 중이면 → no-op ✅
  # masked 상태 (systemctl mask)면 → 항상 FATAL ❌

run_nvidiasmi
  # GPU 인식 검증
  # 실패 시 Slurm이 GPU를 인식하지 못함

efa_driver :setup
  # Elastic Fabric Adapter 드라이버 설치

slurm_install :configure
  # Slurm 설치, slurm.conf 생성
```

모든 쿡북 완료 후:

```
cinc finalize 단계:
  1. /var/run/reboot-required 확인
     → 파일 존재 시: 즉시 재부팅
  2. 재부팅 후: FSx Lustre 마운트
```

> ##### WARNING
>
> 커스텀 AMI가 `/var/run/reboot-required`를 만드는 패키지를 설치하면, cinc finalize가 노드를 재부팅시켜 CustomActions가 실행되지 않습니다. GPU 클러스터에서 원인 불명의 재부팅이 발생하는 가장 흔한 원인입니다.
{: .block-warning }

---

## CustomActions 타이밍: 핵심 세부사항

ParallelCluster에는 두 가지 CustomActions 진입점이 있으며, **타이밍이 직관적이지 않습니다**:

```
cloud-init (UserData) 완료
    ↓
cinc (Chef) 시작
    ↓
OnNodeStart 실행  ← 여기서 실행됨 (cinc 완료 전!)
    ↓
cinc 계속 실행 후 완료
    ↓
cfn-signal 체크포인트
    ↓
OnNodeConfigured 실행  ← 여기서 실행됨 (cinc 완료 후)
    ↓
slurmd 시작
```

> ##### TIP
>
> OnNodeStart 스크립트에서 `nvidia-smi`를 실행하면 실패합니다 — GDRcopy, fabric_manager, NVIDIA 드라이버가 아직 로드되지 않았기 때문입니다. 모든 GPU 검증은 OnNodeStart가 아닌 **OnNodeConfigured**에 넣으세요.
{: .block-tip }

p6-b200 설정의 실제 예시:

```yaml
# cluster-config-p6b200.yaml
OnNodeStart: |
  #!/bin/bash
  # ❌ 여기서 GPU 검증 하지 마세요 — nvidia-smi가 멈추거나 실패합니다

OnNodeConfigured: |
  #!/bin/bash
  # ✅ 여기서 GPU 상태 검증하세요
  nvidia-smi
  nvidia-fabricmanager -n
```

---

## Slurm 관리 스택: 숨겨진 오케스트라

ParallelCluster는 Slurm을 설치하는 것 이상으로, 완전한 데몬 생태계를 구성합니다:

```
HeadNode:
  slurmctld (Slurm 컨트롤러)
    ↓ 노드 상태 게시

  clustermgtd (pcluster 데몬, root로 실행)
    ↓ slurmctld 모니터링
    ↓ DOWN 상태 노드 감지
    ↓ RebootProgram=/sbin/reboot 트리거 (정적 노드)
    ↓ 또는 종료 (동적 노드)

ComputeNode:
  slurmd (Slurm 노드 에이전트)
    ↓ SlurmdTimeout 초마다 slurmctld에 하트비트 전송
    ↓ 하트비트 실패 시: DOWN 표시

cfn-hup (CloudFormation 모니터)
  ↓ 스택 업데이트 감시
  ↓ 변경 감지 시: slurmctld 재시작
  ↓ slurmctld 재로드 → conf 해시 재생성
  ↓ 모든 노드가 conf 해시 불일치 감지
  ↓ Slurm이 모든 노드를 DOWN 표시
  ↓ clustermgtd가 DOWN 감지 → 모든 노드 재부팅
```

> ##### DANGER
>
> 위의 cfn-hup 루프는 **노드 교체 연쇄 반응**입니다. 클러스터를 업데이트할 때마다 자동으로 발생합니다. 개발 중에는 CustomSlurmSettings에 `DebugFlags: NO_CONF_HASH`를 추가해 이를 방지하세요.
{: .block-danger }

---

## 정적 노드 vs 동적 노드: 스케일링 모델

### 정적 노드 (MinCount > 0)

```
상태: running (항상 켜져 있음)
DOWN 표시 시:
  → clustermgtd가 재부팅 트리거
  → 2~5분 내 노드 복구
```

### 동적 노드 (MinCount = 0)

```
상태: running (작업이 큐에 있을 때만)
SuspendTime 초 동안 유휴 상태면:
  → 인스턴스 종료
다음 작업 시:
  → 새 인스턴스 시작
  → cloud-init + cinc 부트스트랩 (~8~15분)
```

> ##### TIP
>
> p6-b200 같은 GPU 클러스터에서는 **정적 노드가 거의 항상 더 나은 선택입니다**. 동적 노드 시작은 cloud-init + cinc 포함 8~15분이 걸립니다. `MinCount: 1`과 `SuspendTime: 36000`으로 노드를 웜 상태로 유지하세요.
{: .block-tip }

---

## 타임아웃 파라미터: 보이지 않는 튜닝 노브

| 파라미터 | 기본값 | 역할 | p6-b200 권장값 |
|---------|--------|------|--------------|
| `SlurmdTimeout` | 300s | 하트비트 타임아웃 후 노드 DOWN | 300s |
| `ComputeNodeBootstrapTimeout` | 1800s | cloud-init + cinc 최대 시간 | 3600s |
| `KillWait` | 30s | 작업 취소 후 유예 시간 | 60s |
| `SuspendTime` | 300s | 동적 노드 종료까지 유휴 시간 | 36000s |

> ##### DANGER
>
> p6-b200에서 `SuspendTime: 0` 또는 `ScaledownIdletime: 0`을 절대 설정하지 마세요. 유휴 정적 노드의 즉각적인 중단을 트리거해 재시작 시 `ReservationCapacityExceeded`와 DOWN 루프를 유발합니다.
{: .block-danger }

---

## Standalone EC2 테스트가 왜 잘못된 결과를 주는가

```
Standalone EC2 인스턴스 (pcluster AMI)
  ↓ cinc가 설치되지 않음
  ↓ Chef 쿡북이 실행되지 않음
  ↓ nvidia 드라이버가 cinc에 의해 로드되지 않음
  ↓ fabric_manager 시작 타이밍이 다름
  ↓ slurmd 컨텍스트 없음

ParallelCluster 내부
  ↓ cinc가 부트스트랩하며 nvidia_config.rb 실행
  ↓ fabric_manager가 cinc 중에 시작
  ↓ CustomActions 전에 Slurm 설치
  ↓ 스크립트가 완전한 slurmd 컨텍스트로 실행
```

> ##### WARNING
>
> Standalone 테스트 통과, 클러스터 테스트 실패 — 이것이 패턴입니다. Fabric manager 타이밍이 다릅니다. GDRcopy가 다른 시점에 로드됩니다. OnNodeStart에서 fabric_manager를 검증하는 스크립트는 standalone에서는 성공하지만 ParallelCluster에서는 실패합니다.
{: .block-warning }

---

## 프로덕션 디버깅

```bash
# HeadNode에서
tail -f /var/log/slurmctld.log         # 노드 상태 변경
tail -f /var/log/slurm_elastic.log     # clustermgtd 결정
systemctl status cfn-hup               # CloudFormation 모니터 실행 중?

# ComputeNode에서
tail -f /var/log/slurmd.log            # 하트비트, 작업 시작
nvidia-smi                             # GPU 인식?
ls -la /var/run/reboot-required        # 재부팅 대기 중?

# Slurm 상태
sinfo                                  # 노드 상태 개요
scontrol show nodes                    # 노드 상세 설정
```

---

## 핵심 교훈

1. **OnNodeStart는 cinc 완료 전에 실행됨** — 여기서 GPU 검증 금지
2. **pcluster 관리 EC2 태그 변경 금지** — 노드 교체 트리거됨
3. **`/var/run/reboot-required` = 무음 재부팅** — cinc finalize가 감지함
4. **Fabric manager는 이진적** — 실행 중이거나 아니거나, 우아한 저하 없음
5. **`cfn-hup`은 함정** — 모든 CloudFormation 업데이트가 conf 해시 연쇄를 트리거
6. **정적 노드는 `SuspendTime >> 0` 필요** — 0은 DOWN 루프의 지름길

---

> **시리즈**: AWS ParallelCluster로 분산 학습 환경 구축하기
>
> ← 현재 위치: **Part 1: ParallelCluster 동작 원리**
> [Part 2: p6-b200 노드가 계속 재부팅되는 이유 →](/pages/pcluster-series-2-reboots-ko/)
{: .block-tip }
