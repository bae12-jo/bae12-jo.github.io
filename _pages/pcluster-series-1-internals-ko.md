---
title: "Part 2: AWS ParallelCluster 내부 동작 원리"
author: Bailey Sohyeon Cho
layout: post
lang: ko
lang_peer: /pages/pcluster-series-1-internals/
---

# AWS ParallelCluster는 실제로 어떻게 동작하는가

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 1: ParallelCluster는 어떤 서비스인가](/pages/pcluster-series-0-what-is-pcluster-ko/) | [Part 3: p6-b200 노드 재부팅 원인 →](/pages/pcluster-series-2-reboots-ko/)

`pcluster create-cluster`를 실행하면 노드 안에서 대부분의 엔지니어가 보지 못하는 일들이 벌어집니다. 동일한 AMI와 스크립트도 standalone EC2에서와 ParallelCluster 안에서 완전히 다르게 동작합니다. 이 글은 실제로 무슨 일이 일어나는지, 왜 그런지 설명합니다.

---

## create-cluster부터 slurmd까지 실제로 일어나는 일

```
pcluster create-cluster
    ↓
CloudFormation이 스택 생성
(HeadNode, ComputeNode, VPC, 보안 그룹 — config에 정의된 모든 것)
    ↓
EC2가 pcluster AMI로 인스턴스 시작
    ↓
각 인스턴스에서 cloud-init 실행
  phase 1: UserData 실행 (기본 OS 설정)
  phase 2: cinc 부트스트랩 스크립트 실행
    ↓
cinc가 pcluster 쿡북 실행
(nvidia_config.rb, slurm_install.rb, efa_driver.rb ...)
    ↓
cinc finalize 단계에서 /var/run/reboot-required 확인
  → 파일 있으면: 노드 재부팅
    ↓
OnNodeStart 훅 실행 (S3에서, cinc 진행 중에 실행됨)
    ↓
cinc finalize 계속: FSx Lustre 마운트
    ↓
OnNodeConfigured 훅 실행
    ↓
cfn-signal 전송: "이 노드 준비됨"
    ↓
ComputeNode에서 slurmd 시작
HeadNode에서 slurmctld 시작
    ↓
clustermgtd가 노드를 감지하고 idle 표시
```

컴퓨트 노드가 부트스트랩에 실패하면 종료되고 다시 시작됩니다. 동일한 코드가 매번 실행되기 때문에 노드는 같은 방식으로 계속 죽습니다. ParallelCluster는 설정된 한도까지 종료와 재시작을 반복하다가, 문제가 해결되거나 HeadNode 부트스트랩 타임아웃이 만료될 때까지 계속됩니다.

HeadNode 자체에도 타임아웃이 있습니다. `HeadNodeBootstrapTimeout`(기본값 1800초)입니다. HeadNode가 이 윈도우 안에 부트스트랩을 완료하지 못하면 CloudFormation이 전체 스택을 실패로 표시하고 롤백을 트리거합니다. 컴퓨트 노드 실패가 전체 재시도 예산을 다 소진해서 cfn-signal이 도착하기 전에 이 한도를 넘기면 클러스터 배포 자체가 롤백됩니다. 새 클러스터 설정을 반복 테스트할 때는 `HeadNodeBootstrapTimeout`을 충분히 넉넉하게 설정하세요.

---

## cloud-init: EC2 표준 부트스트랩 레이어

cloud-init은 클라우드 인스턴스를 초기화하는 업계 표준 도구입니다. 거의 모든 EC2 AMI에서 첫 부팅 시 자동으로 실행됩니다. ParallelCluster에서 cloud-init은 두 가지를 순서대로 수행합니다.

Phase 1에서는 UserData를 실행합니다. 인스턴스 시작 시 선택적으로 전달할 수 있는 스크립트입니다. ParallelCluster는 이것을 기본 OS 레벨 설정에 사용합니다. 패키지 설치, 네트워크 구성, 파일시스템 레이아웃 준비 등입니다.

Phase 2에서는 cinc 부트스트랩을 실행합니다. 실제 작업이 여기서 일어납니다. ParallelCluster는 pcluster 쿡북을 내려받아 실행하는 cinc 호출을 cloud-init에 내장해 뒀습니다. 별도로 설정하거나 트리거하지 않아도 됩니다. pcluster AMI의 cloud-init 설정에 이미 들어 있어서 자동으로 실행됩니다.

---

## cinc: 왜 돌아가고 무엇을 하는가

cinc는 설정 관리 도구인 Chef Infra Client의 포크입니다. ParallelCluster가 Chef/cinc를 선택한 이유는 GPU 클러스터 설정이 정확한 순서로 실행돼야 하는 수십 가지 상호 의존적인 단계로 이루어지기 때문입니다. 셸 스크립트로는 취약합니다. cinc의 선언적 쿡북 모델은 원하는 상태를 정의하고 모든 노드에 멱등적으로 적용할 수 있습니다.

cinc를 직접 호출하지 않습니다. 설정하지도 않습니다. pcluster AMI에 설치되어 있고 cloud-init이 호출하기 때문에 실행됩니다. OnNodeConfigured 스크립트가 시작되는 시점에 cinc는 이미 모든 작업을 마친 상태입니다.

GPU 노드에서 cinc는 `nvidia_config.rb`를 실행합니다:

```ruby
gdrcopy :configure
  # gdrdrv 커널 모듈 로드
  # GPU Direct RDMA 활성화 (NVLink, EFA, fabric manager에 필요)
  # 이 단계가 성공해야 fabric_manager가 실행됨

fabric_manager :configure
  # nvidia-fabricmanager 시작
  # 이미 실행 중이면 → no-op, cinc가 다음으로 넘어감
  # masked 상태 (systemctl mask)면 → 항상 exit code 1, cinc가 FATAL로 실패
  # disabled 상태면 → 시작 시도

run_nvidiasmi
  # nvidia-smi 실행해서 GPU 인식 검증
  # 여기서 GPU가 안 보이면 Slurm에서도 안 보임

efa_driver :setup
  # 아직 설치 안 됐으면 EFA 드라이버 설치

slurm_install :configure
  # Slurm 설치, slurm.conf 작성
```

모든 쿡북이 완료되면 cinc가 finalize 단계를 실행합니다:

```
cinc finalize:
  1. /var/run/reboot-required 확인
     → 파일 있으면: 즉시 재부팅
  2. FSx Lustre 파일시스템 마운트
```

> ##### WARNING
>
> cinc가 설치하는 패키지 중 하나라도 `/var/run/reboot-required`를 만들면, finalize 단계가 노드를 재부팅시켜 OnNodeConfigured가 실행되지 않습니다. GPU 클러스터에서 원인 불명의 재부팅이 발생하는 가장 흔한 원인입니다. 타임아웃처럼 보이지만 재부팅 트리거입니다. Part 3에서 자세히 다룹니다.
{: .block-warning }

---

## 중요한 것은 타이밍: OnNodeStart vs OnNodeConfigured

두 훅은 시퀀스에서 매우 다른 시점에 실행됩니다:

```
cloud-init (UserData) 완료
    ↓
cinc 시작
    ↓
OnNodeStart 실행  ← cinc 실행 중에 실행됨
    ↓
cinc가 모든 쿡북 + finalize 완료
    ↓
cfn-signal 전송
    ↓
OnNodeConfigured 실행  ← cinc 완전히 끝난 후 실행됨
    ↓
slurmd 시작
```

OnNodeStart는 cinc가 시스템을 설정하는 도중에 실행됩니다. GPU 드라이버가 아직 로드되지 않았고, GDRcopy도 설정되지 않았으며, nvidia-fabricmanager도 시작되지 않았습니다. 이것들이 필요한 작업은 전부 실패합니다.

OnNodeConfigured는 cinc가 모든 것을 끝낸 후에 실행됩니다. GPU 관련 작업은 여기에 넣어야 합니다.

어디에 무엇을 넣는지 구체적인 예시:

```yaml
OnNodeStart: |
  #!/bin/bash
  # 안전: 커널 모듈 로드 (ib_umad), reboot 플래그 정리
  # 안전: 환경 변수 설정, PATH 구성
  # 위험: nvidia-smi (드라이버 아직 로드 안 됨)
  # 위험: CUDA/NCCL 관련 모든 작업
  # 위험: systemctl start nvidia-fabricmanager (cinc가 처리)

OnNodeConfigured: |
  #!/bin/bash
  # cinc가 끝난 후 GPU 상태 전체 검증
  nvidia-smi --query-gpu=name,memory.total --format=csv   # 모든 GPU 인식 확인
  nvidia-smi topo -m                                       # NVLink 토폴로지 확인
  nvidia-fabricmanager -n                                  # fabric manager 확인
  /opt/amazon/efa/bin/fi_info -p efa                       # EFA 인터페이스 확인
  # 안전: 모니터링 에이전트 설치, 서비스 등록
```

---

## 설치 시간이 긴 것들 다루기: enroot, Pyxis, NCCL

컴퓨트 노드에 필요한 것들 중 설치에 시간이 오래 걸리는 것들이 있습니다. enroot, Pyxis(컨테이너용 Slurm SPANK 플러그인), NCCL 라이브러리, nccl-tests 바이너리 등입니다. 이것들을 OnNodeConfigured에서 동기적으로 설치하면 문제가 생깁니다. OnNodeConfigured는 cfn-signal이 발송되기 전에 완료돼야 합니다. 너무 오래 걸리면 부트스트랩이 타임아웃됩니다.

동작하는 패턴: OnNodeConfigured에서 slurmd 시작 후 무거운 설치를 실행하는 systemd 서비스를 등록하고, slurmd가 이미 실행 중이면 명시적으로 트리거합니다.

```ini
# /etc/systemd/system/post-slurmd-setup.service
[Unit]
Description=Post-slurmd heavy installs (enroot, Pyxis, NCCL)
After=slurmd.service
Wants=slurmd.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/post-slurmd-setup.sh
RemainAfterExit=yes
```

```bash
# OnNodeConfigured 마지막 부분
systemctl enable post-slurmd-setup.service

# After=slurmd.service는 상태 전환 시에만 발동합니다.
# OnNodeConfigured가 실행될 때 slurmd는 이미 running이라서
# 의존성 트리거가 발동하지 않습니다. 직접 시작해야 합니다.
if systemctl is-active --quiet slurmd; then
  systemctl start post-slurmd-setup.service &
fi
# &는 의도적: 설치가 백그라운드에서 계속되는 동안 cfn-signal이 제때 발송됨
```

post-slurmd 스크립트는 시간이 얼마나 걸리든 관계없습니다. cfn-signal 이후, 노드가 이미 slurmctld에 등록된 후에 실행되며, 잡 스케줄링을 막지 않습니다.

추가로: NCCL 테스트 바이너리는 크고 빌드 시간이 깁니다. 공유 스토리지(`/fsx/nccl-tests/bin/`)에 한 번만 빌드해서 저장하고, 이후 노드 시작 시에는 빌드를 건너뛰도록 조건을 넣으면 됩니다.

여기서 AMI에 패키지를 pre-bake하기 시작하면 쉽게 빠지는 함정이 있습니다. enroot, Pyxis, NCCL이 이미 AMI에 들어 있는데 OnNodeConfigured 스크립트에서 apt로 다시 설치를 시도하면, apt가 이전에는 필요 없던 `linux-modules-extra` 같은 의존성 패키지를 끌어옵니다. 이 패키지들이 커널 업그레이드를 트리거해 `/var/run/reboot-required`를 생성합니다. cinc finalize가 이 파일을 읽고 노드를 재부팅합니다. slurmd가 하트비트를 보내지 못합니다. clustermgtd가 노드를 비정상으로 판정하고 교체합니다. 무작위 부트스트랩 실패처럼 보이는 교체 루프가 생깁니다.

해결책: 패키지가 AMI에 이미 들어 있으면 OnNodeConfigured에서 설치 단계를 완전히 제거하세요. `dpkg -l` 가드를 쓰더라도 최소화하세요. 그리고 `/etc/apt/apt.conf.d/99-no-reboot-required`가 AMI에 포함되어 있는지 확인해서, 뭔가 빠져나가더라도 플래그가 지워지게 하세요.

> ##### WARNING
>
> OnNodeConfigured에서 `/opt/slurm/etc/plugstack.conf`나 `/etc/slurm/plugstack.conf.d/`를 수정하지 마세요. cinc는 시작 시 Slurm 설정을 검증하면서 plugstack.conf에 참조된 모든 경로가 실제로 존재하는지 확인합니다. 아직 존재하지 않는 `.so` 파일을 가리키는 Pyxis 항목을 추가하면 cinc가 즉시 abort합니다. cfn-signal이 발송되기 전, 50초 이내에 노드가 꺼지고 clustermgtd가 비정상으로 표시합니다. Pyxis SPANK 플러그인 등록은 클러스터 시작 시가 아니라 AMI 빌드 시에 해야 합니다.
{: .block-warning }

---

## clustermgtd: 클러스터의 운영 대장

clustermgtd는 HeadNode에서 root로 실행되는 Python 데몬입니다. 전통적인 온프렘 Slurm 환경에는 존재하지 않는 역할을 합니다. ParallelCluster의 자율 운영 능력 대부분이 여기서 나옵니다.

온프렘에서는 Slurm이 노드를 DOWN으로 표시하면 그게 끝입니다. 잡 스케줄링이 멈추고, 사람이 원인을 파악하고, 수동으로 노드를 복구합니다. 클러스터는 기다립니다.

ParallelCluster에서 clustermgtd는 DOWN 노드에 자동으로 조치를 취합니다. 약 60초마다 실행되는 결정 루프에서 여러 소스의 정보를 동시에 고려합니다.

**EC2 헬스 체크.** clustermgtd는 모든 컴퓨트 노드에 대해 EC2 인스턴스 상태 API를 조회합니다. 하드웨어 장애, 네트워크 연결 실패, 시스템 상태 체크 실패가 있으면 Slurm이 뭐라고 하든 관계없이 clustermgtd가 독립적으로 파악합니다. Slurm만으로는 절대 감지할 수 없는 호스트 레벨 장애를 이렇게 잡아냅니다.

**Slurm 노드 상태.** clustermgtd는 slurmctld의 노드 상태를 읽습니다. slurmctld가 DOWN이나 DRAIN으로 표시한 노드는 조치 대상입니다.

**부트스트랩 상태.** cfn-signal이 발송되기 전 부트스트랩 윈도우 동안, clustermgtd는 `ComputeNodeBootstrapTimeout` 내에 신호가 오지 않는 노드를 감시합니다. 제때 신호가 안 오면 인스턴스를 종료합니다.

노드가 비정상이라고 판단했을 때 무슨 일이 일어나는지는 노드 유형에 따라 다릅니다.

**정적 노드** (`MinCount > 0`): clustermgtd가 인스턴스를 재부팅합니다. 종료하지 않습니다. 정적 노드는 항상 존재해야 하기 때문입니다. 재부팅 후 전체 부트스트랩 시퀀스를 다시 거쳐 클러스터에 합류합니다. 복구에 2~5분 걸립니다.

**동적 노드** (`MinCount = 0`): clustermgtd가 인스턴스를 완전히 종료합니다. 용량이 반환됩니다. 다음에 잡이 그 슬롯을 요청하면 새 인스턴스가 처음부터 시작됩니다.

**drain 처리.** 이것이 온프렘 Slurm과 가장 크게 다른 점입니다. 베어메탈 클러스터에서 노드를 drain하면(`scontrol update node=X state=drain`), 현재 실행 중인 잡이 끝나고 노드가 비어있는 상태로 대기합니다. 사람이 문제를 조사하고 수동으로 복구할 때까지 그 상태가 유지됩니다.

ParallelCluster에서는 idle 상태가 된 drain 노드를 비정상 노드로 처리합니다. clustermgtd가 idle+drain 상태를 감지하고 정적 노드면 재부팅, 동적 노드면 종료합니다. 클러스터가 사람 없이 스스로 복구됩니다. 반대로 수동 점검을 위해 노드를 drain했다면 clustermgtd가 재부팅하기 전에 빠르게 작업해야 합니다. 시간이 필요하면 플릿을 먼저 중단하는 것이 안전합니다.

---

## Slurm 하트비트와 DOWN이 실제로 일어나는 방식

모든 slurmd 프로세스는 `SlurmdTimeout`(기본값 300초, 설정 가능)에 정의된 간격으로 slurmctld에 하트비트를 보냅니다. 하트비트는 컴퓨트 노드에서 HeadNode로 향하는 `REQUEST_NODE_REGISTRATION` RPC입니다.

slurmctld가 `SlurmdTimeout` 초 내에 특정 노드로부터 하트비트를 받지 못하면, slurmctld는 그 노드를 DOWN으로 표시합니다. 컴퓨트 노드가 이 결정에 참여하지 않습니다. HeadNode가 소식을 듣지 못하고 최악을 가정합니다.

실용적인 함의가 있습니다. 컴퓨트 노드가 극도로 부하가 걸려 있을 때(CPU 포화, 네트워크 혼잡, 높은 메모리 압박), slurmd 프로세스가 지연되어 하트비트 윈도우를 놓칠 수 있습니다. 노드가 기술적으로 살아있고 정상인데도 DOWN으로 표시됩니다. 극단적인 GPU 워크로드에서는 드물지만 가능합니다.

slurmctld가 노드를 DOWN으로 표시하면 이후 연쇄 반응은:
1. slurmctld가 노드 상태를 reason과 함께 DOWN으로 업데이트
2. clustermgtd가 다음 폴링 사이클에서 DOWN 상태 감지
3. 정적 노드면: clustermgtd가 인스턴스에서 `/sbin/reboot` 트리거
4. 인스턴스가 재부팅되고 전체 부트스트랩을 다시 거쳐 slurmctld에 재등록
5. slurmctld가 노드 상태를 IDLE로 업데이트

DOWN에서 다시 IDLE까지 인스턴스 부팅 속도에 따라 3~7분 정도 걸립니다.

---

## Capacity Block과 대규모 분산 학습

대규모 분산 학습(수백~수천 GPU)에서 노드 한 대의 장애는 사소한 불편이 아닙니다. 분산 학습 잡은 모든 노드에서 동시에 실행되기 때문에, 노드 한 대가 다운되면 전체 잡이 종료됩니다. 32개 노드 256 GPU로 3일짜리 학습을 돌리다가 노드 하나에 문제가 생기면 마지막 체크포인트 이후의 모든 것을 잃습니다.

학습 중단이 크리티컬한 대규모 분산 학습 환경에서 Capacity Block 예약이 사실상 필수인 이유가 여기 있습니다. Spot 인스턴스는 언제든 회수될 수 있습니다. On-demand 인스턴스는 필요한 규모에서 가용성이 보장되지 않습니다. Capacity Block은 특정 시간에 특정 기간 동안 고정된 수의 인스턴스를 보장합니다.

트레이드오프라면 특정 시간 윈도우에 대한 사전 예약과 약정이 필요하다는 점입니다. CB 가격은 대부분의 경우 on-demand와 비슷하거나 더 낮습니다. 예외는 대규모 장기 계약으로 PPA 할인을 받는 경우인데, 이 경우에만 유닛당 비용이 CB보다 낮아질 수 있습니다. Spot 인스턴스와 달리 CB 예약은 예약한 전체 기간 동안 인스턴스를 보장합니다.

흔한 오해 하나: 예약 중 노드가 실패해서 교체되더라도 CB 슬롯이 사라지지 않습니다. 새 인스턴스 launch도 동일한 예약을 사용합니다. 잃는 것은 시간입니다. 부트스트랩 사이클이 10~20분이라 타이트한 예약 윈도우에서는 누적됩니다. `--rollback-on-failure false`를 사용해 불필요한 인스턴스 사이클링을 최소화하고 예약 윈도우를 효율적으로 쓰세요.

---

## 몰랐던 데몬 스택

```
HeadNode:
  slurmctld
    노드 상태 관리, 잡 스케줄링, conf 해시 배포

  clustermgtd (pcluster 데몬, root 실행)
    ~60초마다 EC2 헬스 체크 폴링
    ~60초마다 slurmctld 노드 상태 폴링
    비정상 정적 노드 재부팅
    비정상 동적 노드 종료
    부트스트랩 실패 노드 교체

ComputeNode:
  slurmd
    SlurmdTimeout마다 slurmctld에 하트비트 전송
    하트비트 실패 시: slurmctld가 노드를 DOWN으로 표시, clustermgtd가 조치

cfn-hup (CloudFormation 모니터, HeadNode)
  스택 업데이트 감시
  변경 감지 시 slurmctld 재시작
  재시작 후 slurm.conf 재생성, 새 conf 해시
  컴퓨트 노드는 이전 해시, slurmctld가 DOWN으로 표시
  clustermgtd가 DOWN 감지, 모든 노드 재부팅
```

마지막 연쇄는 클러스터를 업데이트할 때마다 자동으로 발생합니다. 개발 중에는 `CustomSlurmSettings`에 `DebugFlags=NO_CONF_HASH`를 추가하면 막을 수 있습니다.

> ##### DANGER
>
> 기본적으로 모든 CF 스택 업데이트가 이 연쇄를 트리거합니다. `NO_CONF_HASH` 없이 실행 중인 작업이 있는 상태에서 설정을 변경하면 해당 작업이 종료됩니다.
{: .block-danger }

---

## 타임아웃 파라미터

| 파라미터 | 기본값 | 역할 |
|---------|--------|------|
| `ComputeNodeBootstrapTimeout` | 1800s | cfn-signal이 이 안에 도착해야 함 |
| `SlurmdTimeout` | 300s | 하트비트 타임아웃 후 노드 DOWN |
| `SuspendTime` | 300s | 유휴 후 동적 노드 종료 대기 |

GPU 인스턴스에서는 `ComputeNodeBootstrapTimeout: 3600`으로 설정하세요. cinc 부트스트랩만 15~25분 걸립니다.

동적 노드를 사용한다면 `SuspendTime: 36000`으로 설정하세요. 기본값 300초면 노드가 계속 종료되고 재부팅됩니다.

> ##### DANGER
>
> GPU 인스턴스에서 `SuspendTime: 0`이면 유휴 상태가 되는 즉시 인스턴스가 종료됩니다. Capacity Block 예약을 사용 중이라면 슬롯이 반환되고, 다음 launch는 `ReservationCapacityExceeded`로 실패합니다.
{: .block-danger }

---

## Standalone 테스트의 함정

동일한 pcluster AMI로 standalone EC2에서 OnNodeConfigured 스크립트를 테스트하면 잘못된 방향으로 흐릅니다. Standalone에서는 cinc가 실행되지 않기 때문에, cinc가 처리하는 것들을 스크립트에 전부 넣게 됩니다. 실제 클러스터에서 실행하면 cinc가 이미 그 작업들을 다 했기 때문에 타이밍 충돌이 발생합니다.

p6-b200 디버깅에서 나온 구체적인 사례:

OnNodeConfigured에서 `systemctl enable --now nvidia-fabricmanager` 실행: cinc의 `fabric_manager :configure`가 이미 처리했습니다. 중복 시작이 NVSwitch 초기화 중 race condition을 만듭니다.

OnNodeConfigured에서 `systemctl daemon-reload` 실행: cinc가 이미 여러 번 호출했습니다. GPU 드라이버 초기화 도중 추가 daemon-reload가 p6-b200에서 커널 패닉을 유발했습니다.

OnNodeStart에서 `nvidia-smi` 실행: cinc의 `run_nvidiasmi`가 아직 실행되지 않았습니다. 드라이버 로딩과 경쟁하다 실패합니다.

GPU 설정을 건드리는 OnNodeConfigured 로직을 작성하기 전에, cinc 쿡북이 이미 무엇을 처리하는지 먼저 확인하세요. 소스는 실행 중인 pcluster 노드의 `/etc/chef/cookbooks/aws-parallelcluster-*/`에 있습니다.

---

## 디버깅 레퍼런스

```bash
# HeadNode
tail -f /var/log/slurmctld.log              # 노드 상태 변경, DOWN 원인
tail -f /var/log/slurm_elastic.log          # clustermgtd 결정
systemctl status cfn-hup                    # CloudFormation 모니터 실행 중?

# ComputeNode
tail -f /var/log/slurmd.log                 # 하트비트, 작업 시작
tail -f /var/log/parallelcluster/cinc.log   # cinc 쿡북 실행, 오류
nvidia-smi                                  # GPU 인식?
ls /var/run/reboot-required                 # reboot 플래그 존재?

# Slurm
sinfo -N                                    # 노드별 상태
scontrol show node <nodename>               # 노드 상세 정보, reason 포함
```

---

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 1: ParallelCluster는 어떤 서비스인가](/pages/pcluster-series-0-what-is-pcluster-ko/) | 현재: **Part 2: ParallelCluster 내부 동작 원리** | [Part 3: p6-b200 노드 재부팅 원인 →](/pages/pcluster-series-2-reboots-ko/)
{: .block-tip }
