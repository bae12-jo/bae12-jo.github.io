---
title: "분산 학습 - Part 2: AWS ParallelCluster 내부 동작 원리"
author: Bailey Sohyeon Cho
layout: post
lang: ko
lang_peer: /pages/pcluster-series-1-internals/
---

# AWS ParallelCluster는 실제로 어떻게 동작하는가

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 1: ParallelCluster는 어떤 서비스인가](/pages/pcluster-series-0-what-is-pcluster-ko/) | [Part 3: p6-b200 노드 재부팅 원인 →](/pages/pcluster-series-2-reboots-ko/)

`pcluster create-cluster`를 실행하면 예상보다 훨씬 복잡한 일이 벌어집니다. 동일한 AMI와 스크립트도 standalone EC2에서와 ParallelCluster 안에서 완전히 다르게 동작합니다. 이 글은 그 이유를 설명합니다.

---

## create-cluster부터 slurmd까지 실제로 일어나는 일

```
pcluster create-cluster
    ↓
CloudFormation이 스택 생성 (HeadNode, ComputeNode, VPC, 보안 그룹)
    ↓
EC2가 pcluster AMI로 인스턴스 시작
    ↓
cloud-init phase 1: UserData 실행
    ↓
cloud-init phase 2: cinc (Chef) 부트스트랩 실행
    ↓
cinc가 pcluster 쿡북 실행 (nvidia_config.rb, slurm_install.rb, efa_driver.rb ...)
    ↓
재부팅 (/var/run/reboot-required 있을 경우)
    ↓
OnNodeConfigured 실행
    ↓
cfn-signal 전송
    ↓
ComputeNode에서 slurmd, HeadNode에서 slurmctld 시작
    ↓
clustermgtd가 노드를 감지하고 idle 표시
```

어느 단계든 실패하거나 걸리면 클러스터 생성 전체가 중단됩니다.

---

## cinc: 실제 설정 엔진

ParallelCluster는 노드 설정에 임의의 스크립트를 사용하지 않습니다. **cinc**(Chef Infra Client 포크)로 정해진 쿡북을 실행합니다. cloud-init 이후, CustomActions 이전에 자동으로 실행됩니다.

GPU 노드에서 핵심은 `nvidia_config.rb`입니다. 엄격한 순서로 실행됩니다:

```ruby
gdrcopy :configure
  # gdrdrv 커널 모듈 로드
  # GPU Direct RDMA 활성화 (NVLink, EFA, fabric manager에 필요)

fabric_manager :configure
  # nvidia-fabricmanager 시작
  # 이미 실행 중이면 → no-op
  # masked 상태면 → 항상 exit code 1로 실패

run_nvidiasmi
efa_driver :setup
slurm_install :configure
```

쿡북 완료 후 cinc가 finalize 단계를 실행합니다:

```
cinc finalize:
  1. /var/run/reboot-required 확인
     → 파일 있으면: 재부팅
  2. FSx Lustre 마운트
```

> ##### WARNING
>
> 커스텀 AMI가 설치하는 패키지 중 하나라도 `/var/run/reboot-required`를 만들면, cinc finalize가 노드를 재부팅시켜 OnNodeConfigured가 실행되지 않습니다. GPU 클러스터에서 원인 불명의 재부팅이 발생하는 가장 흔한 원인입니다 — 타임아웃처럼 보이지만 재부팅 트리거입니다.
{: .block-warning }

---

## OnNodeStart vs OnNodeConfigured: 타이밍이 직관적이지 않다

```
cloud-init (UserData) 완료
    ↓
cinc 시작
    ↓
OnNodeStart 실행  ← cinc 완료 전에 실행됨
    ↓
cinc 계속 실행 후 완료
    ↓
cfn-signal
    ↓
OnNodeConfigured 실행  ← cinc 완료 후
    ↓
slurmd 시작
```

OnNodeStart는 cinc가 GPU 드라이버, GDRcopy, fabricmanager를 로드하기 *전에* 실행됩니다. 여기서 `nvidia-smi`를 실행하면 실패하거나 멈춥니다. GPU 검증은 OnNodeConfigured에 넣어야 합니다.

```yaml
OnNodeStart: |
  #!/bin/bash
  # 커널 모듈 준비, reboot 플래그 정리 — nvidia-smi 여기 금지

OnNodeConfigured: |
  #!/bin/bash
  nvidia-smi           # cinc가 끝난 후라 안전
  nvidia-fabricmanager -n
```

---

## 몰랐던 데몬 스택

ParallelCluster는 Slurm만 설치하는 게 아닙니다. 서로 영향을 주는 데몬 여러 개를 만들어냅니다:

```
HeadNode:
  slurmctld
    ↓ 노드 상태 게시

  clustermgtd (pcluster 데몬, root 실행)
    ↓ DOWN 노드 감지
    ↓ 정적 노드면 /sbin/reboot 트리거
    ↓ 동적 노드면 인스턴스 종료

ComputeNode:
  slurmd
    ↓ SlurmdTimeout마다 slurmctld에 하트비트
    ↓ 하트비트 실패 시 DOWN 표시

cfn-hup (CloudFormation 모니터, HeadNode)
  ↓ 스택 업데이트 감시
  ↓ 변경 감지 시 slurmctld 재시작
  ↓ 재시작 → slurm.conf 재생성 → 새 conf 해시
  ↓ 컴퓨트 노드는 이전 해시 → DOWN 표시
  ↓ clustermgtd가 DOWN 감지 → 모든 노드 재부팅
```

마지막 연쇄는 클러스터를 업데이트할 때마다 자동으로 발생합니다. 개발 중에는 `CustomSlurmSettings`에 `DebugFlags=NO_CONF_HASH`를 추가하면 막을 수 있습니다.

> ##### DANGER
>
> 기본적으로 모든 CF 스택 업데이트가 이 연쇄를 트리거합니다. `NO_CONF_HASH` 없이 실행 중인 작업이 있는 상태에서 설정을 변경하면 해당 작업이 종료됩니다.
{: .block-danger }

---

## 정적 노드 vs 동적 노드

**정적 노드** (`MinCount > 0`)는 항상 켜져 있습니다. DOWN이 되면 clustermgtd가 재부팅시킵니다. 2~5분 후 복구됩니다. p6-b200 + Capacity Block 조합에서는 정적 노드가 거의 항상 맞습니다. 동적 노드를 종료하면 CB 슬롯이 반환되고 재확보가 안 될 수 있습니다.

**동적 노드** (`MinCount = 0`)는 작업이 있을 때만 존재합니다. `SuspendTime` 초 동안 유휴 상태면 인스턴스가 종료됩니다. 다음 작업이 오면 처음부터 cloud-init + cinc를 다시 거칩니다.

GPU 클러스터에서는 `SuspendTime: 36000`으로 설정하세요. 기본값 300초면 노드가 계속 종료되고 재부팅됩니다. CB 슬롯도 매번 반환됩니다.

> ##### DANGER
>
> `SuspendTime: 0`이면 유휴 상태가 되는 즉시 인스턴스가 종료됩니다. CB 슬롯이 반환되고, 다음 launch는 `ReservationCapacityExceeded`로 실패합니다. p6-b200에서는 절대 하지 마세요.
{: .block-danger }

---

## 타임아웃 파라미터

| 파라미터 | 기본값 | 역할 |
|---------|--------|------|
| `ComputeNodeBootstrapTimeout` | 1800s | cfn-signal이 이 안에 도착해야 함 |
| `SlurmdTimeout` | 300s | 하트비트 타임아웃 후 노드 DOWN |
| `SuspendTime` | 300s | 유휴 후 동적 노드 종료 대기 |

p6-b200에서는 `ComputeNodeBootstrapTimeout: 3600`으로 설정하세요. cinc 부트스트랩만 15~25분 걸립니다.

---

## Standalone 테스트가 클러스터 테스트를 대체할 수 없는 이유

Standalone EC2 인스턴스에서는 cinc가 실행되지 않습니다. Chef 쿡북도, reboot 플래그도, clustermgtd도, cfn-hup도 없습니다. Part 3에서 다루는 네 가지 실패 원인은 모두 ParallelCluster의 오케스트레이션 레이어가 있어야 트리거됩니다. Standalone에서 잘 되고 클러스터에서 깨진다면, 그 차이가 cinc 단계에 있습니다.

---

## 디버깅 레퍼런스

```bash
# HeadNode
tail -f /var/log/slurmctld.log         # 노드 상태 변경, DOWN 원인
tail -f /var/log/slurm_elastic.log     # clustermgtd 결정
systemctl status cfn-hup               # CloudFormation 모니터 실행 중?

# ComputeNode
tail -f /var/log/slurmd.log            # 하트비트, 작업 시작
nvidia-smi                             # GPU 인식?
ls /var/run/reboot-required            # reboot 플래그 존재?

# Slurm
sinfo -N                               # 노드별 상태
scontrol show node <nodename>          # 노드 상세 정보, reason 포함
```

---

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 1: ParallelCluster는 어떤 서비스인가](/pages/pcluster-series-0-what-is-pcluster-ko/) | 현재: **Part 2: ParallelCluster 내부 동작 원리** | [Part 3: p6-b200 노드 재부팅 원인 →](/pages/pcluster-series-2-reboots-ko/)
{: .block-tip }
