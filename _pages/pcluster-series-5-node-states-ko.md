---
title: "Part 5: ParallelCluster Slurm 노드 상태 읽기"
author: Bailey Sohyeon Cho
layout: post
lang: ko
lang_peer: /pages/pcluster-series-5-node-states-en/
---

# ParallelCluster에서 Slurm 노드 상태 읽기

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 4: 커스텀 AMI 만들기](/pages/pcluster-series-3-custom-ami-ko/) | [Part 6: 모니터링 →](/pages/pcluster-series-5-monitoring-ko/)

`sinfo -N`을 실행하면 상태 컬럼에 `idle~`, `down#`, `alloc*` 같은 값이 나옵니다. 임의의 문자열이 아니라 각 문자가 구체적인 플래그입니다. 이것을 제대로 읽는 것이 클러스터가 실제로 건강한지 아닌지를 아는 차이입니다.

---

## 기본 상태

모든 노드는 기본 상태를 가집니다:

| 기본 상태 | 의미 |
|---------|------|
| `idle` | 잡을 받을 수 있는 상태 |
| `alloc` | 잡 실행 중 |
| `mixed` | CPU/GPU 일부 할당, 일부 여유 |
| `down` | 사용 불가 — clustermgtd가 조치를 취함 |
| `drain` | drain 표시됨 — 새 잡 받지 않음 |
| `draining` | drain 진행 중, 현재 잡은 계속 실행 |
| `drained` | drain 완료, 잡 없음, 조치 대기 |
| `completing` | 잡 완료, 정리 진행 중 |
| `unknown` | 노드 상태 확인 불가 |

---

## 복합 상태 suffix

ParallelCluster는 기본 상태에 suffix를 붙입니다. 여러 suffix가 동시에 붙을 수 있습니다 (예: `down~*`).

| Suffix | 플래그 이름 | 의미 |
|--------|-----------|------|
| `~` | CLOUD | 클라우드 절전 풀에 있음. **EC2 인스턴스가 없음.** Slurm 레코드만 존재. |
| `#` | COMPLETING | 잡 정리 또는 부트스트랩 진행 중. |
| `%` | POWER_SAVING | CLOUD 상태로 파워다운 중. |
| `!` | POWERED_DOWN | clustermgtd에 의해 명시적으로 파워다운됨. |
| `*` | NOT_RESPONDING | Slurm에 등록됐지만 하트비트를 보내지 않음. |
| `+` | DRAIN | drain 플래그 설정됨. |

실제로 자주 보는 조합:

| 보이는 상태 | 의미 |
|-----------|------|
| `idle~` | 파워다운, EC2 인스턴스 없음. 잡 제출 시 launch 트리거. |
| `idle#` | EC2 부팅 중 또는 부트스트랩 진행 중. 아직 준비 안 됨. |
| `idle%` | 파워다운 중. 곧 `idle~` 됨. |
| `idle!` | clustermgtd에 의해 명시적 파워다운. |
| `idle*` | Slurm은 idle로 알지만 노드가 응답 없음. |
| `down~` | 파워다운 + DOWN 상태. `power_down_force` + `resume` 필요. |
| `down#` | 부팅 중이지만 DOWN 상태 — 부트스트랩 실패 가능성. |
| `alloc` | 잡 실행 중, 완전히 정상. |
| `alloc#` | 잡 할당됐지만 노드 아직 configuring (cfn-signal 미수신). |
| `drain+` | drain 플래그 설정됨, 현재 잡은 계속 실행. |

---

## IDLE+CLOUD 함정

`idle~`가 가장 중요하게 이해해야 하는 상태입니다.

`idle~`가 보이면 Slurm은 노드를 available로 보고합니다. 하지만 EC2 인스턴스가 없습니다. 노드는 Slurm 상태 데이터베이스에 레코드로만 존재합니다. 잡이 오면 그때 launch될 미래 인스턴스의 자리 표시자입니다.

이것이 실용적으로 두 가지를 의미합니다.

**잡 제출 관점**: `idle~` 노드에 잡을 제출하는 것 자체는 괜찮습니다. ParallelCluster가 자동으로 EC2 인스턴스를 시작합니다. 하지만 잡이 실제로 실행되기까지 8~20분이 걸립니다. 즉시 실행을 기대했다면 예상보다 오래 기다리게 됩니다.

**모니터링 대시보드 관점**: Grafana stat 패널에서 `idle~` 노드를 "healthy" 또는 "available"로 카운트하면, 실제로 존재하지 않는 용량을 보여주는 대시보드가 됩니다. 4개 노드 중 3개가 `idle~`이고 1개가 `alloc`이라면 이것은 건강한 4노드 클러스터가 아닙니다. 3개가 launch 대기 중인 1노드 클러스터입니다.

실제로 실행 중이고 건강한 노드를 위한 올바른 Prometheus 쿼리:

```promql
# 실제 EC2 인스턴스가 있고 준비된 노드
slurm_node_count_per_state{state=~"idle|alloc.*|mixed.*|completing.*"}

# 파워다운 상태 (EC2 인스턴스 없음)
slurm_node_count_per_state{state=~"idle~|idle!|idle%|powered_down.*"}
```

이 둘을 별도 패널로 유지하세요. 합산하지 마세요.

---

## clustermgtd 결정 테이블

clustermgtd는 약 60초마다 폴링 루프를 실행합니다. 각 노드 상태에 대해 다음과 같이 행동합니다:

| 노드 상태 | clustermgtd 행동 |
|---------|----------------|
| `idle` (정적 노드) | 정상. 조치 없음. |
| `idle~` | 정상. 잡 오면 EC2 launch. |
| `idle*` | NOT_RESPONDING. 지속되면: 재부팅 (정적) 또는 종료 (동적). |
| `down` | 비정상. 재부팅 (정적) 또는 종료 (동적). |
| `down~` | 파워다운 상태이지만 DOWN. resume 시도. |
| `drain+` (idle) | `terminate_drain_nodes=True` (기본): 인스턴스 종료. drain 상태는 Slurm 노드 레코드에 유지되어 다음 인스턴스에 상속됨 — 아래 drain 루프 참조. |
| `drain+` (잡 실행 중) | 잡 완료 대기 후 종료. |
| 부트스트랩 타임아웃 | `ComputeNodeBootstrapTimeout` 내에 cfn-signal 미수신. 종료. |
| EC2 헬스 체크 실패 | 하드웨어 장애 감지. Slurm 상태와 무관하게 종료. |

---

## drain 상태 상속 루프

ParallelCluster에서 가장 까다로운 실패 패턴 중 하나입니다. 문서에서 잘 설명되지 않습니다.

정적 노드가 drain 상태로 들어가고 idle이 되면 (잡 완료 또는 잡 없음), clustermgtd가 인스턴스를 종료합니다 (기본 `terminate_drain_nodes=True`). 새 인스턴스가 교체를 위해 launch됩니다. 문제는 여기서 시작합니다. Slurm은 인스턴스 ID가 아닌 이름으로 노드를 관리합니다. 새 인스턴스는 같은 노드 이름을 받습니다. 그리고 그 노드 이름은 Slurm 상태 데이터베이스에 여전히 `drain+` 플래그가 설정되어 있습니다. 새 인스턴스는 drain 상태로 태어납니다. clustermgtd가 봅니다: idle + drain = 비정상. 다시 종료합니다.

```
노드 drain 진입 → 잡 완료
→ clustermgtd: idle+drain = unhealthy → terminate
→ 새 인스턴스 launch (같은 노드 이름)
→ Slurm 노드 레코드: drain 플래그 그대로
→ 새 인스턴스: drain 상태로 시작
→ clustermgtd: 즉시 terminate
→ 루프
```

Capacity Block 예약이 1개뿐이라면, 종료된 인스턴스가 슬롯을 반환하기 전에 다음 launch가 `ReservationCapacityExceeded`로 실패합니다. 30~40분을 기다려야 할 수 있습니다.

**해결책**: 인스턴스가 종료되기 전에 drain을 해제합니다.

```bash
# drain 노드 확인
sinfo -N | grep -E "drain|drained"

# clustermgtd가 종료하기 전에 drain 해제
scontrol update nodename=<NODE> state=resume

# 이미 루프에 빠진 경우:
scontrol update nodename=<NODE> state=power_down_force
sleep 10
scontrol update nodename=<NODE> state=resume
# CB 슬롯이 해제될 때까지 대기
```

---

## 잡 취소 후 새 잡: 60초 규칙

`scancel`로 잡을 취소하면 프로세스는 즉시 종료되지만 slurmd와 slurmstepd가 프로세스 그룹 정리, GPU 핸들 해제, 내부 상태 업데이트를 완료하는 데 시간이 필요합니다. 정리가 끝나기 전에 새 잡이 배정되면 slurmd가 "Unspecified error"를 던지고, clustermgtd가 헬스 실패로 판단해 인스턴스를 종료합니다.

```bash
# 잘못된 방법 — 노드 죽음
scancel <JOB_ID>
sbatch next_job.sh

# 올바른 방법
scancel <JOB_ID>
sleep 60
# 노드가 suffix 없는 깨끗한 idle인지 확인
sinfo -N | grep <NODE>
sleep 120
sbatch next_job.sh
```

`scancel` 후 최소 60초 대기입니다. 이전 잡이 무거운 GPU 작업이었다면 2~3분이 더 안전합니다.

---

## 프로그래밍 방식으로 노드 상태 읽기

```bash
# 노드별 상태 개요
sinfo -N --format="%N %T %O %e" --noheader

# DOWN/DRAIN 원인 포함 노드 상세 정보
scontrol show node <nodename>

# 상태 변화 감시 (5초마다 갱신)
watch -n 5 "sinfo -N"

# 문제 있는 상태 노드 목록
sinfo -N | grep -E "down|drain|unknown|not_respond"

# Prometheus (slurm_exporter 통해)
# slurm_node_count_per_state{state="idle"}        # 실제 idle 인스턴스
# slurm_node_count_per_state{state="idle~"}       # 파워다운
# slurm_node_state_reason{node="...",reason="..."}  # down/drain 원인
```

---

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 4: 커스텀 AMI 만들기](/pages/pcluster-series-3-custom-ami-ko/) | 현재: **Part 5: 노드 상태 읽기** | [Part 6: 모니터링 →](/pages/pcluster-series-5-monitoring-ko/)
{: .block-tip }
